/**
 * ComputerAgentServer — host the SDK as a REST/SSE API.
 *
 * Wraps `new ComputerAgent({...})` behind an HTTP endpoint so any client
 * (curl, Python, browser, another service) can run any GAP agent without
 * embedding the TypeScript SDK.
 *
 *   POST /run     — full agent config + message in JSON; SSE stream out
 *   GET  /health  — up check
 *   GET  /artifact?sessionId=&path=  — fetch a workdir file (during run)
 *
 * Private repo support: pass `gitToken` in the body and the server
 * rewrites the `source.url` with HTTPS basic-auth credentials, so simple-git
 * clones the private repo without leaking the token to other endpoints.
 *
 * Session persistence: pass `sessionStore: { kind: "mongo" | "file" | "memory" }`
 * (with optional `options`) to enable cross-process conversation resume.
 * Combine with `sessionId` to continue a prior conversation. The `mongo`
 * kind reads `MONGO_URL` from the harness env when `options.url` is omitted,
 * so credentials stay server-side.
 *
 *   curl -N -X POST http://127.0.0.1:8787/run -H 'content-type: application/json' \
 *     -d '{
 *       "source": { "type": "git", "url": "github.com/myorg/private-agent" },
 *       "gitToken": "ghp_xxx",
 *       "harness": "claude-agent-sdk",
 *       "envs": { "ANTHROPIC_API_KEY": "sk-..." },
 *       "options": { "permissionMode": "bypassPermissions", "settingSources": ["project"] },
 *       "message": "Write a one-line summary of README.md"
 *     }'
 */

import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { serve, type ServerType } from "@hono/node-server";
import { ComputerAgent, LocalSubstrate } from "computeragent";
import type { IdentitySource, Substrate } from "computeragent";
import type {
  HarnessEvent,
  PersistedEvent,
  TaskDoc,
  TaskStore,
  TaskStatus,
  TaskSummary,
} from "@computeragent/protocol";
import { mongoTaskStoreBuilder } from "@computeragent/task-store-mongo";

type TaskStoreBuilder = (options?: unknown) => TaskStore;

export interface ComputerAgentServerOptions {
  /** Bind host. Default "127.0.0.1" (loopback only). Pass "0.0.0.0" for LAN-accessible. */
  readonly host?: string;
  readonly port: number;
  /**
   * Env vars merged into every spawned agent's env. Per-request `envs` win.
   * Useful for setting a default `ANTHROPIC_API_KEY` without putting it in
   * every request body.
   */
  readonly defaultEnvs?: Readonly<Record<string, string>>;
  /**
   * Registry of substrate factories keyed by wire-side `runtime` name.
   * Clients pick which to use per-request via the `runtime` field in the
   * /run body. Built-ins shipped with examples:
   *   - "local" → LocalSubstrate (process boundary, no security boundary)
   *   - "bwrap" → BwrapSubstrate (Linux namespace isolation, recommended)
   *   - "e2b"   → E2BSubstrate (Firecracker VMs, external service)
   *
   * Register the ones your deployment supports:
   *
   *   substrates: {
   *     local: () => new LocalSubstrate(),
   *     bwrap: () => new BwrapSubstrate({ extraRoBinds: [...] }),
   *   }
   *
   * If only one is registered, it's used regardless of what the client asks for.
   * If both `substrates` and the legacy `substrate` are absent, requests use a
   * fresh LocalSubstrate per call (matches the v0 default).
   */
  readonly substrates?: Readonly<Record<string, () => Substrate>>;
  /**
   * Default `runtime` when the request body omits it. Must be a key in
   * `substrates`. If unset, the first registered key wins.
   */
  readonly defaultRuntime?: string;
  /**
   * @deprecated Pass via `substrates: { default: () => ... }` and `defaultRuntime: "default"` instead.
   * Kept for backward compatibility with the singular-substrate v0 shape.
   */
  readonly substrate?: () => Substrate;
  /**
   * Hard cap on concurrent agent runs. Beyond this, /run returns 429.
   * Default: 4 (LocalSubstrate spawns a Node process per agent).
   */
  readonly maxConcurrentRuns?: number;
  /**
   * Registry of task-store backends keyed by wire-side `kind`. Clients pick
   * which to use per-task via the `taskStore` field in the POST /tasks body.
   *   taskStores: { mongo: mongoTaskStoreBuilder({ url: process.env.MONGO_URL! }) }
   * Built-in: "memory" (in-process, lost on restart). The example startup
   * also auto-registers "mongo" when MONGO_URL is in the env.
   */
  readonly taskStores?: Readonly<Record<string, TaskStoreBuilder>>;
  /**
   * Default task-store kind when POST /tasks omits one. Must be a key in
   * `taskStores`. If unset, the first registered key wins (or "memory").
   */
  readonly defaultTaskStore?: string;
}

interface RunBody {
  source: IdentitySource | string;
  harness: string;
  /**
   * Which substrate to spawn the agent inside. Names come from the server's
   * `substrates` registry (e.g. "local", "bwrap", "e2b"). If omitted, the
   * server uses its `defaultRuntime`. Unknown values → 400 UNKNOWN_RUNTIME
   * with the list of available names.
   */
  runtime?: string;
  message: string | Array<{ role: "user"; content: string }>;
  envs?: Record<string, string>;
  options?: Record<string, unknown>;
  model?: string;
  temperature?: number;
  baseUrl?: string;
  /** Personal access token for private git sources (currently github-style). */
  gitToken?: string;
  sessionId?: string;
  /** Enable verbose harness logs via COMPUTERAGENT_LOG=debug in the spawned harness. */
  debug?: boolean;
  /**
   * Pluggable session store. Built-in kinds shipped with the spawned harness:
   *   - "memory"  (default, in-process; lost on dispose)
   *   - "file"    options: { root: "/path/to/dir" }
   *   - "mongo"   options: { url?: "mongodb://...", database?: "..." }
   *               url omitted ⇒ falls back to MONGO_URL in the harness env
   *               (pass it via top-level `envs` so the credential never
   *               crosses the wire)
   * Pair with `sessionId` to resume an existing conversation across processes.
   */
  sessionStore?: { kind: string; options?: unknown };
  /**
   * Files to land in the agent's workdir BEFORE the engine starts. Written
   * AFTER the GAP repo is materialized, so attachments overlay on top
   * (caller wins on path collisions). Path-jailed by the harness server.
   *
   *   attachments: [
   *     { path: "input.csv",  content: "name,age\nA,30\n" },
   *     { path: "report.pdf", content: "JVBERi0...", encoding: "base64" }
   *   ]
   *
   * The agent's tools (Read, Bash, etc.) see them as regular files in cwd.
   * Works with any substrate (local/bwrap/e2b) and any harness — files
   * are written once into the workdir, every engine sees them natively.
   */
  attachments?: Array<{ path: string; content: string; encoding?: "utf8" | "base64" }>;
}

interface ActiveRun {
  agent: InstanceType<typeof ComputerAgent>;
  startedAt: number;
}

/**
 * In-memory broker: per-task pub/sub for live SSE clients. Persisted history
 * comes from the TaskStore; this just lets connected clients tail new events
 * as they arrive without polling.
 */
class TaskBroker {
  private readonly subscribers = new Map<string, Set<(ev: PersistedEvent) => void>>();
  private readonly closed = new Set<string>();
  private readonly cancelHandlers = new Map<string, () => void>();

  subscribe(taskId: string, cb: (ev: PersistedEvent) => void): () => void {
    let set = this.subscribers.get(taskId);
    if (!set) {
      set = new Set();
      this.subscribers.set(taskId, set);
    }
    set.add(cb);
    return () => {
      set?.delete(cb);
      if (set?.size === 0) this.subscribers.delete(taskId);
    };
  }

  broadcast(taskId: string, ev: PersistedEvent): void {
    const set = this.subscribers.get(taskId);
    if (!set) return;
    for (const cb of set) {
      try { cb(ev); } catch { /* swallow */ }
    }
  }

  closeTask(taskId: string): void {
    this.closed.add(taskId);
    this.subscribers.delete(taskId);
    this.cancelHandlers.delete(taskId);
  }

  isClosed(taskId: string): boolean {
    return this.closed.has(taskId);
  }

  onCancel(taskId: string, handler: () => void): void {
    this.cancelHandlers.set(taskId, handler);
  }

  cancel(taskId: string): boolean {
    const handler = this.cancelHandlers.get(taskId);
    if (!handler) return false;
    try { handler(); } catch { /* swallow */ }
    return true;
  }
}

/**
 * Fallback in-process TaskStore. Lost on server restart — use mongo (or
 * another durable backend) for anything past a dev demo. Useful as the
 * zero-config default so the API works without any external infra.
 */
class MemoryTaskStore implements TaskStore {
  private readonly docs = new Map<string, {
    taskId: string; sessionId: string; status: TaskStatus;
    config?: Record<string, unknown>;
    events: PersistedEvent[];
    usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number };
    startedAt: Date; endedAt?: Date; lastEventAt: Date;
    error?: string;
    artifactRefs?: { path: string; bytes: number; chunkId?: string }[];
  }>();

  async createTask(taskId: string, init: { sessionId: string; config?: Record<string, unknown>; status?: TaskStatus }): Promise<void> {
    if (this.docs.has(taskId)) return;
    const now = new Date();
    this.docs.set(taskId, {
      taskId, sessionId: init.sessionId, status: init.status ?? "queued",
      events: [], startedAt: now, lastEventAt: now,
      ...(init.config ? { config: init.config } : {}),
    });
  }

  async appendEvent(taskId: string, ev: PersistedEvent): Promise<void> {
    const d = this.docs.get(taskId);
    if (!d) return;
    if (d.events.some((e) => e.id === ev.id)) return;
    d.events.push(ev);
    d.lastEventAt = ev.ts;
  }

  async updateStatus(taskId: string, status: TaskStatus, fields?: Record<string, unknown>): Promise<void> {
    const d = this.docs.get(taskId);
    if (!d) return;
    d.status = status;
    if (fields) Object.assign(d, fields);
  }

  async load(taskId: string): Promise<TaskDoc | null> {
    return (this.docs.get(taskId) ?? null) as TaskDoc | null;
  }

  async loadEventsSince(taskId: string, since: number): Promise<readonly PersistedEvent[]> {
    return this.docs.get(taskId)?.events.filter((e) => e.id > since) ?? [];
  }

  async listTasks(filter?: { status?: TaskStatus | readonly TaskStatus[]; limit?: number }): Promise<readonly TaskSummary[]> {
    const out = [...this.docs.values()]
      .filter((d) => !filter?.status
        || (Array.isArray(filter.status) ? filter.status.includes(d.status) : d.status === filter.status))
      .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
      .slice(0, filter?.limit ?? 50);
    return out.map(({ events: _e, ...rest }) => rest) as TaskSummary[];
  }

  async delete(taskId: string): Promise<void> { this.docs.delete(taskId); }
}

export class ComputerAgentServer {
  private readonly opts: ComputerAgentServerOptions;
  private readonly app = new Hono();
  private server: ServerType | null = null;
  private readonly runs = new Map<string, ActiveRun>();
  private readonly broker = new TaskBroker();
  private readonly taskStores: Record<string, TaskStoreBuilder>;
  /** Live agents for in-flight tasks, keyed by taskId. */
  private readonly liveTasks = new Map<string, InstanceType<typeof ComputerAgent>>();

  constructor(opts: ComputerAgentServerOptions) {
    this.opts = opts;
    // Task store registry: caller's `taskStores` wins over the built-in
    // memory default. The startup example also auto-registers `mongo` when
    // MONGO_URL is set in the environment — that wiring lives in the
    // example's main() to keep this class infra-agnostic.
    this.taskStores = {
      memory: () => new MemoryTaskStore(),
      ...(opts.taskStores ?? {}),
    };
    this.wire();
  }

  async listen(): Promise<{ host: string; port: number }> {
    const host = this.opts.host ?? "127.0.0.1";
    const port = this.opts.port;
    await new Promise<void>((resolve) => {
      this.server = serve({ fetch: this.app.fetch, hostname: host, port }, () => resolve());
    });
    return { host, port };
  }

  async close(): Promise<void> {
    // Tear down any in-flight agent runs first so their substrates don't outlive us.
    await Promise.all([...this.runs.values()].map((r) => r.agent.dispose().catch(() => {})));
    this.runs.clear();
    if (this.server) {
      await new Promise<void>((r) => {
        this.server!.close(() => r());
      });
      this.server = null;
    }
  }

  private wire(): void {
    // CORS: this is an unauthenticated public API; the same callers that
    // can curl it from anywhere should be able to fetch() it from a browser
    // (test.html, dashboards, etc.). origin:"*" is consistent with the
    // server's existing no-auth posture. Add a proper auth layer first if
    // you want to restrict cross-origin browser access.
    this.app.use(
      "*",
      cors({
        origin: "*",
        allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
        allowHeaders: ["content-type", "accept", "last-event-id"],
        exposeHeaders: ["content-type"],
        maxAge: 86400,
      }),
    );

    this.app.get("/health", (c) =>
      c.json({
        ok: true,
        activeRuns: this.runs.size,
        max: this.opts.maxConcurrentRuns ?? 4,
        runtimes: this.availableRuntimes(),
        defaultRuntime: this.resolveDefaultRuntime(),
      }),
    );

    this.app.post("/run", async (c) => {
      const max = this.opts.maxConcurrentRuns ?? 4;
      if (this.runs.size >= max) {
        return c.json({ error: { code: "TOO_MANY_RUNS", active: this.runs.size, max } }, 429);
      }

      let body: RunBody;
      try {
        body = (await c.req.json()) as RunBody;
      } catch (err) {
        return c.json({ error: { code: "INVALID_JSON", message: (err as Error).message } }, 400);
      }

      const validation = validateRunBody(body);
      if (validation) return c.json({ error: validation }, 400);

      // Resolve which substrate factory to use for this request.
      // Precedence: body.runtime → defaultRuntime → first registered → legacy
      // singular `substrate` → fresh LocalSubstrate.
      const runtimeResult = this.resolveRuntime(body.runtime);
      if (!runtimeResult.ok) {
        return c.json({ error: runtimeResult.error }, 400);
      }
      const buildSubstrate = runtimeResult.factory;

      const source = applyGitToken(normalizeSource(body.source), body.gitToken);
      const envs = {
        ...this.opts.defaultEnvs,
        ...body.envs,
      };
      if (!envs.ANTHROPIC_API_KEY && body.harness !== "gitagent") {
        // gitagent can also use other providers; only enforce key for engines that need it
        const fromHost = process.env.ANTHROPIC_API_KEY;
        if (fromHost) envs.ANTHROPIC_API_KEY = fromHost;
      }

      const agent = new ComputerAgent({
        source,
        harness: body.harness as never,
        runtime: buildSubstrate(),
        envs,
        ...(body.options ? { options: body.options } : {}),
        ...(body.model ? { model: body.model } : {}),
        ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
        ...(body.baseUrl ? { baseUrl: body.baseUrl } : {}),
        ...(body.sessionId ? { sessionId: body.sessionId } : {}),
        ...(body.debug ? { debug: true } : {}),
        ...(body.sessionStore ? { sessionStore: body.sessionStore as never } : {}),
        ...(body.attachments && body.attachments.length > 0
          ? { attachments: body.attachments }
          : {}),
      });

      // Track the agent so /artifact can find it by sessionId while the run is live.
      const placeholderId = `pending-${Math.random().toString(36).slice(2, 8)}`;
      this.runs.set(placeholderId, { agent, startedAt: Date.now() });

      return streamSSE(c, async (stream) => {
        let realSessionId: string | undefined;
        stream.onAbort(async () => {
          await agent.dispose().catch(() => {});
          this.runs.delete(placeholderId);
          if (realSessionId) this.runs.delete(realSessionId);
        });

        try {
          const handle = agent.chat(
            typeof body.message === "string" ? body.message : body.message,
          );
          for await (const ev of handle) {
            if (ev.kind === "ca_session_started" && !realSessionId) {
              realSessionId = ev.sessionId;
              this.runs.set(realSessionId, { agent, startedAt: Date.now() });
            }
            await stream.writeSSE({
              event: ev.kind,
              data: JSON.stringify(ev),
            });
            if (ev.kind === "ca_session_ended") break;
          }
          // Final summary event with the usage rollup the SDK aggregated.
          const usage = handle.getUsage();
          await stream.writeSSE({
            event: "ca_done",
            data: JSON.stringify({ sessionId: realSessionId, usage }),
          });
        } catch (err) {
          await stream.writeSSE({
            event: "ca_error",
            data: JSON.stringify({ message: (err as Error).message }),
          });
        } finally {
          // Give the client a tick to receive the final events before tearing
          // down the substrate (which drops the workdir on the floor for any
          // /artifact follow-ups).
          await stream.sleep(50);
          await agent.dispose().catch(() => {});
          this.runs.delete(placeholderId);
          if (realSessionId) this.runs.delete(realSessionId);
        }
      });
    });

    // Best-effort artifact fetch — works WHILE the run is live (between the
    // first ca_session_started event and ca_session_ended). After the agent
    // disposes, the substrate's workdir is gone; the client must capture
    // artifacts before that.
    this.app.get("/artifact", async (c) => {
      const sessionId = c.req.query("sessionId");
      const path = c.req.query("path");
      if (!sessionId || !path) {
        return c.json({ error: { code: "MISSING_PARAM", message: "sessionId and path are required" } }, 400);
      }
      const run = this.runs.get(sessionId);
      if (!run) {
        return c.json({ error: { code: "NOT_FOUND", sessionId } }, 404);
      }
      const bytes = await run.agent.fetchArtifact(path);
      if (!bytes) return c.json({ error: { code: "NOT_FOUND", path } }, 404);
      return new Response(new Uint8Array(bytes), {
        headers: { "Content-Type": "application/octet-stream" },
      });
    });

    // List the session workdir while the run is live.
    this.app.get("/workdir", async (c) => {
      const sessionId = c.req.query("sessionId");
      if (!sessionId) {
        return c.json({ error: { code: "MISSING_PARAM", message: "sessionId is required" } }, 400);
      }
      const run = this.runs.get(sessionId);
      if (!run) return c.json({ error: { code: "NOT_FOUND", sessionId } }, 404);
      const tree = await run.agent.listWorkdir({ depth: 3 });
      return c.json({ entries: tree });
    });

    // ── /tasks — background execution, persisted to a TaskStore ───────────
    //
    // Same shape as /run but:
    //   - POST returns 202 + taskId immediately (no SSE on this call)
    //   - the agent runs to completion regardless of client disconnect
    //   - every HarnessEvent is persisted via the TaskStore (mongo / memory)
    //   - status + events queryable via GET /tasks/:id and /events
    //   - DELETE /tasks/:id cancels mid-flight
    //
    // The wire shape is intentionally close to /run so a client switching
    // between modes only adds the polling layer.

    this.app.post("/tasks", async (c) => {
      let body: RunBody & { taskStore?: { kind: string; options?: unknown } };
      try {
        body = (await c.req.json()) as never;
      } catch (err) {
        return c.json({ error: { code: "INVALID_JSON", message: (err as Error).message } }, 400);
      }
      const validation = validateRunBody(body);
      if (validation) return c.json({ error: validation }, 400);

      const runtimeResult = this.resolveRuntime(body.runtime);
      if (!runtimeResult.ok) return c.json({ error: runtimeResult.error }, 400);

      // Pick the task store backend. Default: caller's defaultTaskStore →
      // "mongo" if registered, else "memory".
      const storeKind =
        body.taskStore?.kind ??
        this.opts.defaultTaskStore ??
        (this.taskStores.mongo ? "mongo" : "memory");
      const storeBuilder = this.taskStores[storeKind];
      if (!storeBuilder) {
        return c.json({
          error: {
            code: "UNKNOWN_TASK_STORE",
            message: `task store '${storeKind}' not registered`,
            available: Object.keys(this.taskStores),
          },
        }, 400);
      }
      const taskStore = storeBuilder(body.taskStore?.options);

      const taskId = `task_${randomUUID().slice(0, 12)}`;
      const sessionId = body.sessionId ?? taskId;

      // Persist task creation BEFORE returning so the client can immediately
      // poll without a race. Redact env values from the persisted config —
      // they're secrets, not debug-relevant content.
      const safeConfig = redactConfig(body);
      await taskStore.createTask(taskId, { sessionId, config: safeConfig, status: "queued" });

      // Fire-and-forget: the run continues regardless of the HTTP request.
      void this.runTask({
        taskId, sessionId, body, taskStore,
        buildSubstrate: runtimeResult.factory,
      }).catch((err) => {
        // Last-resort: any uncaught error in runTask gets logged + the task
        // is marked errored. The internal try/catch handles most cases; this
        // is defense against bugs in our own code.
        // eslint-disable-next-line no-console
        console.error("[tasks] runTask threw:", err);
        taskStore.updateStatus(taskId, "errored", {
          endedAt: new Date(),
          error: err instanceof Error ? err.message : String(err),
        }).catch(() => {});
      });

      return c.json({ taskId, sessionId, status: "queued" }, 202);
    });

    this.app.get("/tasks", async (c) => {
      const storeKind = c.req.query("taskStore") ?? this.opts.defaultTaskStore ?? "mongo";
      const builder = this.taskStores[storeKind];
      if (!builder) return c.json({ error: { code: "UNKNOWN_TASK_STORE", available: Object.keys(this.taskStores) } }, 400);
      const store = builder();
      const status = c.req.query("status");
      const limit = Number.parseInt(c.req.query("limit") ?? "50", 10);
      const tasks = await store.listTasks({
        ...(status ? { status: status as TaskStatus } : {}),
        limit: Number.isFinite(limit) ? limit : 50,
      });
      return c.json({ tasks });
    });

    this.app.get("/tasks/:id", async (c) => {
      const taskId = c.req.param("id");
      const storeKind = c.req.query("taskStore") ?? this.opts.defaultTaskStore ?? "mongo";
      const builder = this.taskStores[storeKind];
      if (!builder) return c.json({ error: { code: "UNKNOWN_TASK_STORE", available: Object.keys(this.taskStores) } }, 400);
      const store = builder();
      const doc = await store.load(taskId);
      if (!doc) return c.json({ error: { code: "NOT_FOUND", taskId } }, 404);
      // Return a slim status snapshot. Use /tasks/:id/events to fetch the log.
      return c.json({
        taskId: doc.taskId,
        sessionId: doc.sessionId,
        status: doc.status,
        eventCount: doc.events.length,
        usage: doc.usage,
        startedAt: doc.startedAt,
        endedAt: doc.endedAt,
        lastEventAt: doc.lastEventAt,
        error: doc.error,
        artifactRefs: doc.artifactRefs,
      });
    });

    this.app.get("/tasks/:id/events", async (c) => {
      const taskId = c.req.param("id");
      const storeKind = c.req.query("taskStore") ?? this.opts.defaultTaskStore ?? "mongo";
      const builder = this.taskStores[storeKind];
      if (!builder) return c.json({ error: { code: "UNKNOWN_TASK_STORE", available: Object.keys(this.taskStores) } }, 400);
      const store = builder();
      const accept = c.req.header("accept") ?? "";
      const wantsSse = accept.includes("text/event-stream");

      // JSON polling form — fetch events with id > since.
      if (!wantsSse) {
        const since = Number.parseInt(c.req.query("since") ?? "-1", 10);
        const doc = await store.load(taskId);
        if (!doc) return c.json({ error: { code: "NOT_FOUND", taskId } }, 404);
        const sinceN = Number.isFinite(since) ? since : -1;
        const events = doc.events.filter((e: PersistedEvent) => e.id > sinceN);
        const nextSince = events.length > 0 ? events[events.length - 1].id : sinceN;
        const done = doc.status === "complete" || doc.status === "errored" || doc.status === "cancelled";
        return c.json({ events, nextSince, done, status: doc.status });
      }

      // SSE form — replay persisted history, then tail live broadcasts.
      const lastEventId = Number.parseInt(
        c.req.header("Last-Event-ID") ?? c.req.query("lastEventId") ?? "-1",
        10,
      );
      return streamSSE(c, async (stream) => {
        const doc = await store.load(taskId);
        if (!doc) {
          await stream.writeSSE({ event: "ca_error", data: JSON.stringify({ code: "NOT_FOUND", taskId }) });
          return;
        }
        // 1. Cold replay: every event past Last-Event-ID
        const sinceN = Number.isFinite(lastEventId) ? lastEventId : -1;
        let highWater = sinceN;
        for (const ev of doc.events) {
          if (ev.id <= sinceN) continue;
          await stream.writeSSE({ event: ev.kind, id: String(ev.id), data: JSON.stringify(ev.payload) });
          highWater = ev.id;
        }
        // 2. If terminal, close. Else live-tail until the broker closes us.
        if (doc.status === "complete" || doc.status === "errored" || doc.status === "cancelled") {
          await stream.writeSSE({ event: "ca_done", data: JSON.stringify({ taskId, status: doc.status }) });
          return;
        }
        const done = new Promise<void>((resolve) => {
          const unsubscribe = this.broker.subscribe(taskId, (ev) => {
            if (ev.id <= highWater) return;
            highWater = ev.id;
            stream.writeSSE({ event: ev.kind, id: String(ev.id), data: JSON.stringify(ev.payload) }).catch(() => {});
            // Terminal events end the stream.
            if (ev.kind === "ca_session_ended") {
              setTimeout(() => { unsubscribe(); resolve(); }, 100);
            }
          });
          stream.onAbort(() => { unsubscribe(); resolve(); });
        });
        await done;
      });
    });

    this.app.get("/tasks/:id/artifact", async (c) => {
      const taskId = c.req.param("id");
      const path = c.req.query("path");
      if (!path) return c.json({ error: { code: "MISSING_PATH" } }, 400);
      // While the task is live, the agent still owns the workdir — fetch via it.
      const live = this.liveTasks.get(taskId);
      if (live) {
        const bytes = await live.fetchArtifact(path);
        if (!bytes) return c.json({ error: { code: "NOT_FOUND", path } }, 404);
        return new Response(new Uint8Array(bytes), { headers: { "Content-Type": "application/octet-stream" } });
      }
      // Task ended — would need a stable workdir or store-backed artifacts.
      // For v1 we surface a clear 410 so clients know to fetch during the run.
      return c.json({
        error: {
          code: "GONE",
          message: "Task has ended. Artifact fetch after completion requires a stable workdir or store-backed artifacts — not yet implemented. Fetch via /tasks/:id/artifact while status=running.",
        },
      }, 410);
    });

    this.app.delete("/tasks/:id", async (c) => {
      const taskId = c.req.param("id");
      const ok = this.broker.cancel(taskId);
      // Best-effort: status flips to "cancelled" inside runTask's finally.
      return c.json({ ok, taskId });
    });
  }

  /**
   * Background runner — drives the agent to completion, persists every
   * event, exposes the live stream via the broker. Detached from the HTTP
   * request that created the task (POST /tasks returns immediately).
   */
  private async runTask(opts: {
    taskId: string;
    sessionId: string;
    body: RunBody;
    taskStore: TaskStore;
    buildSubstrate: () => Substrate;
  }): Promise<void> {
    const { taskId, sessionId, body, taskStore, buildSubstrate } = opts;
    const source = applyGitToken(normalizeSource(body.source), body.gitToken);
    const envs = { ...this.opts.defaultEnvs, ...body.envs };
    if (!envs.ANTHROPIC_API_KEY && body.harness !== "gitagent") {
      const fromHost = process.env.ANTHROPIC_API_KEY;
      if (fromHost) envs.ANTHROPIC_API_KEY = fromHost;
    }

    const agent = new ComputerAgent({
      source,
      harness: body.harness as never,
      runtime: buildSubstrate(),
      envs,
      sessionId,                                              // pin so resume works
      ...(body.options ? { options: body.options } : {}),
      ...(body.model ? { model: body.model } : {}),
      ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
      ...(body.baseUrl ? { baseUrl: body.baseUrl } : {}),
      ...(body.debug ? { debug: true } : {}),
      ...(body.sessionStore ? { sessionStore: body.sessionStore as never } : {}),
      ...(body.attachments && body.attachments.length > 0 ? { attachments: body.attachments } : {}),
    });
    this.liveTasks.set(taskId, agent);

    // Cancel hook — runs in response to DELETE /tasks/:id. Disposes the
    // agent (SIGTERM the substrate); the for-await below sees an empty
    // tail or a cancelled session end event and exits cleanly.
    let cancelRequested = false;
    this.broker.onCancel(taskId, () => {
      cancelRequested = true;
      agent.dispose().catch(() => {});
    });

    await taskStore.updateStatus(taskId, "running", { startedAt: new Date() });

    let eventIndex = 0;
    let usage: { inputTokens?: number; outputTokens?: number; costUsd?: number } | undefined;

    try {
      const message = typeof body.message === "string" ? body.message : body.message;
      const handle = agent.chat(message as never);
      for await (const ev of handle as AsyncIterable<HarnessEvent>) {
        const persisted: PersistedEvent = {
          id: eventIndex++,
          ts: new Date(),
          kind: ev.kind,
          // Drop `kind` from the payload — the wrapper carries it. The rest
          // of the event (sessionId + kind-specific fields) lands in payload.
          payload: ((): unknown => {
            const { kind: _kind, ...rest } = ev as Record<string, unknown> & { kind: string };
            return rest;
          })(),
        };
        // Persist FIRST so any client that just attached sees the same total
        // ordering as the on-disk record before the live broadcast hits.
        await taskStore.appendEvent(taskId, persisted);
        this.broker.broadcast(taskId, persisted);

        if (ev.kind === "ca_usage_snapshot") {
          usage = handle.getUsage();
        }
        if (ev.kind === "ca_session_ended") break;
      }
      // Final status: cancelled wins over complete if requested mid-flight.
      const finalStatus: TaskStatus = cancelRequested ? "cancelled" : "complete";
      await taskStore.updateStatus(taskId, finalStatus, {
        endedAt: new Date(),
        ...(usage ? { usage } : {}),
      });
    } catch (err) {
      await taskStore.updateStatus(taskId, "errored", {
        endedAt: new Date(),
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.liveTasks.delete(taskId);
      this.broker.closeTask(taskId);
      await agent.dispose().catch(() => {});
    }
  }

  /**
   * Map a per-request `runtime` name to the registered substrate factory.
   * Returns a discriminated result so the route handler can convert "unknown
   * runtime" into a clean 400 with the available list.
   */
  private resolveRuntime(
    requested: string | undefined,
  ):
    | { ok: true; factory: () => Substrate }
    | { ok: false; error: { code: string; message: string; available: string[] } } {
    const registry = this.opts.substrates;
    const fallback = this.opts.substrate;
    const available = this.availableRuntimes();

    // Explicit request: must match a registered key.
    if (requested) {
      const factory = registry?.[requested];
      if (factory) return { ok: true, factory };
      // If only the legacy singular substrate is set, accept whatever the
      // client asked for (one-substrate deployment — the name is informational).
      if (!registry && fallback) return { ok: true, factory: fallback };
      return {
        ok: false,
        error: {
          code: "UNKNOWN_RUNTIME",
          message: `runtime '${requested}' not registered on this server`,
          available,
        },
      };
    }

    // No explicit request: use defaultRuntime, then the first registered, then
    // the legacy singular factory, then a fresh LocalSubstrate.
    if (registry) {
      const defaultName = this.opts.defaultRuntime ?? Object.keys(registry)[0];
      const factory = defaultName ? registry[defaultName] : undefined;
      if (factory) return { ok: true, factory };
    }
    if (fallback) return { ok: true, factory: fallback };
    return { ok: true, factory: () => new LocalSubstrate() };
  }

  private availableRuntimes(): string[] {
    if (this.opts.substrates) return Object.keys(this.opts.substrates);
    if (this.opts.substrate) return ["<legacy-singleton>"];
    return ["local"];
  }

  private resolveDefaultRuntime(): string | undefined {
    if (this.opts.substrates) {
      return this.opts.defaultRuntime ?? Object.keys(this.opts.substrates)[0];
    }
    return undefined;
  }
}

// ── helpers ──────────────────────────────────────────────────────────────

function normalizeSource(source: IdentitySource | string): IdentitySource {
  if (typeof source !== "string") return source;
  // Heuristic: anything with github.com/owner/repo or ending in .git is a git source.
  if (
    source.startsWith("github.com/") ||
    source.startsWith("https://") ||
    source.startsWith("git@") ||
    source.endsWith(".git")
  ) {
    return { type: "git", url: source };
  }
  return { type: "local", path: source };
}

/**
 * If a PAT is supplied, embed it in the HTTPS URL using GitHub's standard
 * `x-access-token` basic-auth pattern. simple-git uses the credential
 * transparently; the token never appears in subsequent request paths.
 *
 * Supports:
 *   - `github.com/owner/repo`        → `https://x-access-token:<TOK>@github.com/owner/repo`
 *   - `https://github.com/owner/repo` → same
 *
 * SSH URLs (`git@github.com:owner/repo`) are passed through unchanged — they
 * authenticate by key, not token.
 */
function applyGitToken(source: IdentitySource, token: string | undefined): IdentitySource {
  if (!token || source.type !== "git") return source;
  const url = source.url;
  if (url.startsWith("github.com/")) {
    return { ...source, url: `https://x-access-token:${token}@${url}` };
  }
  if (url.startsWith("https://github.com/")) {
    return { ...source, url: url.replace("https://", `https://x-access-token:${token}@`) };
  }
  // Unknown shape (gitlab, bitbucket, ssh, custom). Pass through; caller can
  // pre-format the URL with whatever scheme that host expects.
  return source;
}

/**
 * Strip secrets from the request body before it lands in the task store.
 * The full config is useful for debugging (which harness, which model, which
 * runtime), but `envs` carries credentials and `gitToken` is a PAT — neither
 * belongs in the persisted record.
 */
function redactConfig(body: RunBody & { taskStore?: unknown }): Record<string, unknown> {
  const { envs: _envs, gitToken: _gt, attachments, ...rest } = body;
  return {
    ...rest,
    ...(attachments ? { attachments: attachments.map((a) => ({ path: a.path, bytes: a.content.length, encoding: a.encoding ?? "utf8" })) } : {}),
    envsKeys: Object.keys(body.envs ?? {}),
    hasGitToken: Boolean(body.gitToken),
  };
}

function validateRunBody(body: unknown): { code: string; message: string } | undefined {
  if (!body || typeof body !== "object") return { code: "INVALID_BODY", message: "body must be a JSON object" };
  const b = body as Record<string, unknown>;
  if (!b.source) return { code: "MISSING_SOURCE", message: "source is required" };
  if (!b.harness || typeof b.harness !== "string") {
    return { code: "MISSING_HARNESS", message: "harness is required (e.g. 'claude-agent-sdk')" };
  }
  if (!b.message) return { code: "MISSING_MESSAGE", message: "message is required" };
  return undefined;
}

// ── Example ──
// Run with: `node --experimental-strip-types --no-warnings examples/computeragent-server.ts`
if (import.meta.url === `file://${process.argv[1]}`) {
  // Lazy-import optional substrates so missing E2B credentials / non-Linux
  // hosts don't crash a deployment that only wants LocalSubstrate.
  const { BwrapSubstrate } = await import("@computeragent/runtime-bwrap");
  const { E2BSubstrate } = await import("@computeragent/runtime-e2b");

  const substrates: Record<string, () => Substrate> = {
    local: () => new LocalSubstrate(),
  };

  // bwrap: Linux only. Register when bwrap is on PATH AND the runtime deps
  // have been staged. The path can be overridden via BWRAP_RUNTIME_DIR.
  if (process.platform === "linux") {
    const runtimeDir = process.env.BWRAP_RUNTIME_DIR ?? "/var/lib/computeragent/runtime";
    substrates.bwrap = () =>
      new BwrapSubstrate({
        extraRoBinds: [{ src: `${runtimeDir}/node_modules`, dest: "/harness/node_modules" }],
      });
  }

  // e2b: Register when E2B_API_KEY is set. Each session spins up its own
  // Firecracker microVM via E2B's infra.
  if (process.env.E2B_API_KEY) {
    substrates.e2b = () => new E2BSubstrate({ apiKey: process.env.E2B_API_KEY });
  }

  // Auto-forward selected host env vars into every spawned substrate. Bwrap
  // wipes all env vars from the sandbox by default, so anything the inner
  // harness server needs (model API keys, session-store URLs, etc.) MUST be
  // explicitly forwarded. Listing keys here is the audit point: only these
  // get exposed to agent processes.
  const FORWARD = [
    "ANTHROPIC_API_KEY",
    "E2B_API_KEY",
    "EXA_API_KEY",
    "OPENAI_API_KEY",
    "MONGO_URL",
    "MONGO_DATABASE",
  ];
  const defaultEnvs: Record<string, string> = {};
  for (const k of FORWARD) {
    const v = process.env[k];
    if (v) defaultEnvs[k] = v;
  }

  // Task store registry — mirrors the substrate pattern. We always register
  // the in-memory fallback; `mongo` only registers when MONGO_URL is set so
  // a misconfigured host doesn't silently default to a broken backend.
  const taskStores: Record<string, TaskStoreBuilder> = {};
  if (process.env.MONGO_URL) {
    taskStores.mongo = mongoTaskStoreBuilder({
      url: process.env.MONGO_URL,
      ...(process.env.MONGO_DATABASE ? { database: process.env.MONGO_DATABASE } : {}),
      collection: process.env.MONGO_TASKS_COLLECTION ?? "tasks",
    });
  }
  // Pick the default: mongo if available, else fall back to the in-process
  // memory store registered by the server itself.
  const defaultTaskStore = process.env.DEFAULT_TASK_STORE
    ?? (taskStores.mongo ? "mongo" : "memory");

  const server = new ComputerAgentServer({
    host: process.env.HOST ?? "127.0.0.1",
    port: Number(process.env.PORT ?? 8787),
    defaultEnvs: Object.keys(defaultEnvs).length > 0 ? defaultEnvs : undefined,
    maxConcurrentRuns: 4,
    substrates,
    defaultRuntime: process.env.DEFAULT_RUNTIME ?? "local",
    ...(Object.keys(taskStores).length > 0 ? { taskStores } : {}),
    defaultTaskStore,
  });
  const { host, port } = await server.listen();
  console.log(`ComputerAgentServer listening on http://${host}:${port}`);
  console.log("");
  console.log("Endpoints:");
  console.log("  GET  /health                    runtimes + default + active count");
  console.log("  POST /run                       body: {source, harness, runtime?, message, envs?, options?, gitToken?, model?, sessionStore?, sessionId?, debug?, attachments?}");
  console.log("  GET  /workdir?sessionId=<id>");
  console.log("  GET  /artifact?sessionId=<id>&path=<path>");
  console.log("  POST /tasks                     body: same as /run + taskStore?: {kind, options?}; returns 202 {taskId}");
  console.log("  GET  /tasks                     ?status=&limit= — list recent tasks");
  console.log("  GET  /tasks/:id                 status snapshot");
  console.log("  GET  /tasks/:id/events          ?since=<n> JSON poll, or Accept: text/event-stream for SSE");
  console.log("  GET  /tasks/:id/artifact        ?path=<path> — while task is live");
  console.log("  DEL  /tasks/:id                 cancel");
  console.log(`  defaultTaskStore: ${defaultTaskStore}  (registered: ${["memory", ...Object.keys(taskStores)].join(", ")})`);
  console.log("");
  console.log("Example:");
  console.log("  curl -N -X POST http://" + host + ":" + port + "/run \\");
  console.log("    -H 'content-type: application/json' \\");
  console.log("    -d '{");
  console.log('      "source": "github.com/shreyas-lyzr/pdf-agent",');
  console.log('      "harness": "claude-agent-sdk",');
  console.log('      "runtime": "local",');
  console.log('      "options": { "permissionMode": "bypassPermissions", "settingSources": ["project"] },');
  console.log('      "message": "Write hello.pdf with one line of text"');
  console.log("    }'");
}
