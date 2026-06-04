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

import { randomUUID, timingSafeEqual } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { Readable } from "node:stream";
import * as tar from "tar-stream";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { serve, type ServerType } from "@hono/node-server";
import { ComputerAgent, LocalSubstrate } from "computeragent";
import type { IdentitySource, Substrate } from "computeragent";
import type {
  HarnessEvent,
  PersistedEvent,
  SandboxSnapshot,
  SandboxUsage,
  SessionStoreRef,
  SnapshotFilter,
  SnapshotSummary,
  StateStore,
  TaskDoc,
  TaskStore,
  TaskStatus,
  TaskSummary,
} from "@open-gitagent/protocol";
import { mongoTaskStoreBuilder } from "@computeragent/task-store-mongo";
import { s3StateStoreBuilder } from "@computeragent/state-store-s3";
import type { AuditSink } from "@computeragent/harness-server";
import {
  configure as configureOtel,
  shutdown as shutdownOtel,
  OtelAuditSink,
} from "@computeragent/observability";

type TaskStoreBuilder = (options?: unknown) => TaskStore;
type StateStoreBuilder = (options?: unknown) => StateStore;

/**
 * Fan one HarnessEvent out to the configured AuditSink, swallowing any errors
 * so observability failures never break a session. Tracks the sessionId across
 * the stream (learned from `ca_session_started` when not provided upfront).
 */
function emitToAuditSink(
  sink: AuditSink | undefined,
  state: { sessionId: string; counter: number },
  ev: HarnessEvent,
): void {
  if (!sink) return;
  if (ev.kind === "ca_session_started" && !state.sessionId) state.sessionId = ev.sessionId;
  try {
    void sink.onEvent({
      sessionId: state.sessionId || (ev as { sessionId?: string }).sessionId || "pending",
      eventId: ++state.counter,
      event: ev,
      timestamp: Date.now(),
    });
  } catch {
    // OtelAuditSink already swallows its own errors; this is belt-and-braces.
  }
}

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
  /**
   * Substrate factory signature accepts an optional per-call `timeoutMs`.
   * Used by warm sandboxes to bump E2B's external idle timer (default 5m)
   * up to match our sandbox.ttlMs + a grace window — otherwise the E2B
   * service kills the substrate before our TTL fires.
   * Substrates that have no external timer (bwrap, local) ignore the arg.
   */
  readonly substrates?: Readonly<Record<string, (opts?: { timeoutMs?: number }) => Substrate>>;
  /**
   * Default `runtime` when the request body omits it. Must be a key in
   * `substrates`. If unset, the first registered key wins.
   */
  readonly defaultRuntime?: string;
  /**
   * @deprecated Pass via `substrates: { default: () => ... }` and `defaultRuntime: "default"` instead.
   * Kept for backward compatibility with the singular-substrate v0 shape.
   */
  readonly substrate?: (opts?: { timeoutMs?: number }) => Substrate;
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
  /**
   * Registry of state-store backends for sandbox snapshot/restore.
   * Built-in: "memory" (in-process, lost on restart, useful for tests).
   * The example startup auto-registers "s3" when S3_BUCKET is set.
   *   stateStores: { s3: s3StateStoreBuilder({ bucket: "..." }) }
   */
  readonly stateStores?: Readonly<Record<string, StateStoreBuilder>>;
  /**
   * Default state-store kind when a snapshot/restore request omits one.
   * Must be a registered key. If unset, the first registered key wins
   * (typically `memory` since it's always registered).
   */
  readonly defaultStateStore?: string;
  /**
   * Long-lived sandbox pool tuning. A sandbox keeps a `ComputerAgent` (and
   * its substrate) alive between HTTP requests so multi-turn conversations
   * don't re-clone/install/boot for every turn.
   *
   * Two TTL knobs, both refresh-on-clamp:
   *   - idleTtlMs: dispose after this much inactivity (each chat resets it).
   *   - ttlMs:     absolute hard cap from creation. Fires regardless of activity.
   *
   * Clients pick both per-request; server clamps to `maxIdleTtlMs` / `maxTtlMs`.
   */
  readonly sandbox?: {
    /** Hard cap on concurrent live sandboxes. Beyond this POST /sandboxes returns 429. Default 8. */
    readonly maxConcurrent?: number;
    /** Default idleTtlMs when the request omits it. Default 10 * 60_000. */
    readonly defaultIdleTtlMs?: number;
    /** Default ttlMs when the request omits it. Default 30 * 60_000. */
    readonly defaultTtlMs?: number;
    /** Server-side upper bound for idleTtlMs. Default 30 * 60_000. */
    readonly maxIdleTtlMs?: number;
    /** Server-side upper bound for ttlMs. Default 120 * 60_000 (2h). */
    readonly maxTtlMs?: number;
    /** Reaper sweep interval. Default 5_000. */
    readonly reaperIntervalMs?: number;
    /**
     * If POST /sandboxes is followed by NO /chat within this window, the
     * sandbox is reaped (avoids dangling agents from broken clients).
     * Default 60_000.
     */
    readonly bootDeadlineMs?: number;
  };
  /**
   * Optional audit sink — every HarnessEvent produced by /run, /tasks, and
   * /sandboxes/:id/chat is forwarded synchronously. Used by
   * `@computeragent/observability`'s `OtelAuditSink` to emit OTel `gen_ai.*`
   * spans + metrics. Sink errors are caught and dropped; observability never
   * impacts the agent run.
   */
  readonly auditSink?: AuditSink;
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
  /** Per-tool-call policy enforcement (forwarded to the harness decider). */
  policy?: { kind: "srs"; endpoint: string; apiKey: string; policyId: string; principalId: string };
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

// ── In-process state-store fallback (Wedge 1.13) ────────────────────────
//
// Mirrors MemoryTaskStore. Useful for tests and the always-registered
// default when no durable backend is configured. Snapshots live in a Map
// keyed by snapshotId — lost on server restart.
class MemoryStateStore implements StateStore {
  private readonly snaps = new Map<string, SandboxSnapshot>();

  async save(snap: SandboxSnapshot): Promise<{ snapshotId: string; sizeBytes: number }> {
    this.snaps.set(snap.snapshotId, snap);
    return { snapshotId: snap.snapshotId, sizeBytes: snap.workdirBytes };
  }
  async load(snapshotId: string): Promise<SandboxSnapshot | null> {
    return this.snaps.get(snapshotId) ?? null;
  }
  async list(filter?: SnapshotFilter): Promise<readonly SnapshotSummary[]> {
    let out = [...this.snaps.values()].map(({ workdirTar: _t, ...rest }) => rest as SnapshotSummary);
    if (filter?.sourceSandboxId) out = out.filter((s) => s.sourceSandboxId === filter.sourceSandboxId);
    if (filter?.since) {
      const sinceMs = filter.since.getTime();
      out = out.filter((s) => s.takenAt.getTime() >= sinceMs);
    }
    out.sort((a, b) => b.takenAt.getTime() - a.takenAt.getTime());
    return filter?.limit ? out.slice(0, filter.limit) : out;
  }
  async delete(snapshotId: string): Promise<void> { this.snaps.delete(snapshotId); }
}

// ── Sandbox pool (Wedge 1.12) ───────────────────────────────────────────
//
// A "sandbox" is a warm `ComputerAgent` + substrate kept alive across
// multiple HTTP requests, bounded by an idle TTL (refreshed on each chat)
// and an absolute hard TTL. The SDK already supports calling `chat()`
// repeatedly on a single instance (lazy substrate boot, memoized via
// `this.booted` in computer-agent.ts); this registry is what stops the
// example server from disposing the agent the moment a stream ends.

type SandboxState = "booting" | "ready" | "busy" | "restoring" | "expired" | "disposed";

interface LiveSandbox {
  readonly id: string;
  sessionId: string;
  /**
   * Mutable agent reference. `replaceAgentInPlace` swaps this when restoring
   * a snapshot onto an existing sandbox slot (target = "<existingId>"). Read
   * paths go through `sandbox.agent` — never cache the reference.
   */
  agent: InstanceType<typeof ComputerAgent>;
  state: SandboxState;
  readonly createdAt: Date;
  lastActivityAt: Date;
  /** Absolute hard cap. Fires regardless of activity. */
  readonly expiresAt: Date;
  /** Idle cap. Refreshed on each chat completion. */
  idleExpiresAt: Date;
  turnCount: number;
  usage: { inputTokens?: number; outputTokens?: number; cacheCreationInputTokens?: number; cacheReadInputTokens?: number; costUsd?: number };
  currentTurn: { startedAt: Date } | null;
  config: Record<string, unknown>;
  readonly idleTtlMs: number;
  readonly ttlMs: number;
  /** Set to true on POST /chat; if no chat arrives within bootDeadlineMs, reaper kills the sandbox. */
  firstChatSeen: boolean;
  readonly bootDeadlineAt: Date;
  /**
   * If set, the registry snapshots the sandbox to this state store BEFORE
   * disposing it (TTL fire, explicit DELETE, server shutdown). Snapshot
   * failures are logged but do NOT block tear-down.
   */
  autoSave?: { stateStoreKind: string; stateStoreOptions?: unknown };
}

interface SandboxSummary {
  sandboxId: string;
  sessionId: string;
  state: SandboxState;
  createdAt: Date;
  lastActivityAt: Date;
  expiresAt: Date;
  idleExpiresAt: Date;
  turnCount: number;
  busy: boolean;
  usage: LiveSandbox["usage"];
  config: Record<string, unknown>;
}

class SandboxRegistry {
  private readonly sandboxes = new Map<string, LiveSandbox>();
  private reapTimer: NodeJS.Timeout | null = null;

  size(): number { return this.sandboxes.size; }
  get(id: string): LiveSandbox | undefined { return this.sandboxes.get(id); }
  has(id: string): boolean { return this.sandboxes.has(id); }
  insert(sb: LiveSandbox): void { this.sandboxes.set(sb.id, sb); }

  list(): SandboxSummary[] {
    return [...this.sandboxes.values()].map(summarize);
  }

  /**
   * Atomically take a sandbox out of the map. Caller is responsible for
   * disposing the agent — kept separate so close() can dispose in parallel.
   */
  detach(id: string): LiveSandbox | undefined {
    const sb = this.sandboxes.get(id);
    if (!sb) return undefined;
    this.sandboxes.delete(id);
    return sb;
  }

  async remove(
    id: string,
    reason: "expired" | "explicit" | "shutdown",
    preDispose?: (sb: LiveSandbox) => Promise<void>,
  ): Promise<void> {
    const sb = this.detach(id);
    if (!sb) return;
    // preDispose runs BEFORE the substrate goes down — used by auto-save to
    // snapshot the workdir while it's still readable. Failures here are
    // logged but never block tear-down (a flaky S3 must not strand a live
    // substrate).
    if (preDispose) {
      try {
        await preDispose(sb);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`[sandbox] ${id} preDispose failed (${reason}):`, err);
      }
    }
    sb.state = "disposed";
    await sb.agent.dispose().catch(() => {});
    if (reason !== "shutdown") {
      // eslint-disable-next-line no-console
      console.log(`[sandbox] ${id} disposed (${reason}) turns=${sb.turnCount}`);
    }
  }

  /**
   * Start the periodic reaper. Idempotent. The `reaper` callback is invoked
   * for each expired sandbox; it MUST eventually call `registry.remove(id, "expired", ...)`
   * (the caller wires it that way so autoSave preDispose hooks can plug in).
   * Default reaper: `this.remove(id, "expired")` with no preDispose.
   */
  start(intervalMs: number, reaper?: (id: string) => Promise<void>): void {
    if (this.reapTimer) return;
    this.reapFn = reaper ?? ((id) => this.remove(id, "expired"));
    this.reapTimer = setInterval(() => { void this.reapOnce(); }, intervalMs);
    // Don't keep the process alive solely for the reaper.
    this.reapTimer.unref?.();
  }

  private reapFn: (id: string) => Promise<void> = (id) => this.remove(id, "expired");

  stop(): void {
    if (this.reapTimer) {
      clearInterval(this.reapTimer);
      this.reapTimer = null;
    }
  }

  private async reapOnce(): Promise<void> {
    const now = Date.now();
    const toReap: string[] = [];
    for (const sb of this.sandboxes.values()) {
      // Hard cap wins over busy — guarantees the sandbox can't outlive ttlMs.
      if (sb.expiresAt.getTime() <= now) { toReap.push(sb.id); continue; }
      // Boot deadline: created but never chatted. Drops dangling sandboxes.
      if (!sb.firstChatSeen && sb.bootDeadlineAt.getTime() <= now) { toReap.push(sb.id); continue; }
      // Idle cap only applies when not actively serving a turn / being
      // restored. Both states have transient operations the reaper must
      // not interrupt.
      if (sb.state !== "busy" && sb.state !== "restoring" && sb.idleExpiresAt.getTime() <= now) { toReap.push(sb.id); continue; }
    }
    await Promise.all(toReap.map((id) => this.reapFn(id).catch(() => {})));
  }
}

function summarize(sb: LiveSandbox): SandboxSummary {
  return {
    sandboxId: sb.id,
    sessionId: sb.sessionId,
    state: sb.state,
    createdAt: sb.createdAt,
    lastActivityAt: sb.lastActivityAt,
    expiresAt: sb.expiresAt,
    idleExpiresAt: sb.idleExpiresAt,
    turnCount: sb.turnCount,
    busy: sb.state === "busy",
    usage: sb.usage,
    config: sb.config,
  };
}

/**
 * Resolve and clamp client-supplied TTL fields. Returns the effective values
 * the registry should use. Rejects via thrown error if the result would be
 * absurd (negative / zero / hard < idle).
 */
function resolveSandboxTtl(
  clientIdleMs: number | undefined,
  clientHardMs: number | undefined,
  cfg: NonNullable<ComputerAgentServerOptions["sandbox"]>,
): { idleTtlMs: number; ttlMs: number } {
  const idleDef = cfg.defaultIdleTtlMs ?? 10 * 60_000;
  const hardDef = cfg.defaultTtlMs ?? 30 * 60_000;
  const idleMax = cfg.maxIdleTtlMs ?? 30 * 60_000;
  const hardMax = cfg.maxTtlMs ?? 120 * 60_000;

  const idleRaw = clientIdleMs ?? idleDef;
  const hardRaw = clientHardMs ?? hardDef;
  if (idleRaw <= 0 || hardRaw <= 0) {
    throw new Error("idleTtlMs and ttlMs must be positive milliseconds");
  }
  // Hard cap is the authority. Idle gets clamped DOWN to it — a sandbox
  // can't be idle-alive longer than its absolute lifetime. This matches
  // the intuitive reading: "dispose after X idle OR after Y total,
  // whichever fires first."
  const ttlMs = Math.min(hardRaw, hardMax);
  const idleTtlMs = Math.min(idleRaw, idleMax, ttlMs);
  return { idleTtlMs, ttlMs };
}

/**
 * Drop secrets from the POST /sandboxes body before stashing it on the
 * sandbox doc. Mirrors `redactConfig` for tasks — same redaction surface.
 */
function redactSandboxConfig(body: SandboxBody): Record<string, unknown> {
  const { envs: _envs, gitToken: _gt, attachments, ...rest } = body;
  return {
    ...rest,
    ...(attachments ? { attachments: attachments.map((a) => ({ path: a.path, bytes: a.content.length, encoding: a.encoding ?? "utf8" })) } : {}),
    envsKeys: Object.keys(body.envs ?? {}),
    hasGitToken: Boolean(body.gitToken),
  };
}

/**
 * POST /sandboxes body. Subset of RunBody minus `message` (message arrives
 * via /chat) plus the two TTL knobs.
 */
interface SandboxBody {
  source: IdentitySource | string;
  harness: string;
  runtime?: string;
  envs?: Record<string, string>;
  options?: Record<string, unknown>;
  model?: string;
  temperature?: number;
  baseUrl?: string;
  gitToken?: string;
  sessionId?: string;
  debug?: boolean;
  sessionStore?: { kind: string; options?: unknown };
  policy?: { kind: "srs"; endpoint: string; apiKey: string; policyId: string; principalId: string };
  attachments?: Array<{ path: string; content: string; encoding?: "utf8" | "base64" }>;
  idleTtlMs?: number;
  ttlMs?: number;
  /**
   * Opt-in: snapshot to this state store BEFORE the sandbox disposes
   * (TTL fire, explicit DELETE, server shutdown). Snapshot ID is
   * auto-derived. The store must already be registered on the server.
   */
  autoSave?: { stateStore: { kind: string; options?: unknown } };
}

interface SandboxChatBody {
  message: string | Array<{ role: "user"; content: string }>;
  attachments?: Array<{ path: string; content: string; encoding?: "utf8" | "base64" }>;
}

export class ComputerAgentServer {
  private readonly opts: ComputerAgentServerOptions;
  private readonly app = new Hono();

  /**
   * Mount another Hono app under this server's HTTP listener. Used by the
   * Slack-bot module to attach /slack/* routes without booting a separate
   * port. Call BEFORE `listen()`.
   */
  mount(subApp: Hono): void {
    this.app.route("/", subApp);
  }
  private server: ServerType | null = null;
  private readonly runs = new Map<string, ActiveRun>();
  private readonly broker = new TaskBroker();
  private readonly taskStores: Record<string, TaskStoreBuilder>;
  private readonly stateStores: Record<string, StateStoreBuilder>;
  /** Live agents for in-flight tasks, keyed by taskId. */
  private readonly liveTasks = new Map<string, InstanceType<typeof ComputerAgent>>();
  private readonly sandboxes = new SandboxRegistry();

  constructor(opts: ComputerAgentServerOptions) {
    this.opts = opts;
    // Task store registry: caller's `taskStores` wins over the built-in
    // memory default. The startup example also auto-registers `mongo` when
    // MONGO_URL is set in the environment — that wiring lives in the
    // example's main() to keep this class infra-agnostic.
    // Memory backends MUST be singletons — the builder closure is invoked
    // separately for save / load / list, and a fresh instance per call
    // would mean a snapshot saved by one request is invisible to the
    // restore route. Durable backends (mongo, s3) don't have this problem
    // because the underlying server is the source of truth.
    const memoryTaskStoreSingleton = new MemoryTaskStore();
    const memoryStateStoreSingleton = new MemoryStateStore();
    this.taskStores = {
      memory: () => memoryTaskStoreSingleton,
      ...(opts.taskStores ?? {}),
    };
    this.stateStores = {
      memory: () => memoryStateStoreSingleton,
      ...(opts.stateStores ?? {}),
    };
    this.wire();
  }

  async listen(): Promise<{ host: string; port: number }> {
    const host = this.opts.host ?? "127.0.0.1";
    const port = this.opts.port;
    await new Promise<void>((resolve) => {
      this.server = serve({ fetch: this.app.fetch, hostname: host, port }, () => resolve());
    });
    // Sandbox reaper: walks the registry every reaperIntervalMs and disposes
    // any sandbox past its idle or hard TTL. Started after the HTTP listener
    // is up so no /sandboxes request can land before the reaper exists.
    // Pass a custom reaper that runs auto-save before disposal. The
    // registry calls reapFn(id) for each expired sandbox; we look up the
    // sandbox, build its auto-save preDispose hook (if any), then call
    // remove(...). preDispose runs WHILE the substrate is still up so the
    // workdir is readable.
    this.sandboxes.start(this.opts.sandbox?.reaperIntervalMs ?? 5_000, (id) => {
      const sb = this.sandboxes.get(id);
      const pre = sb ? this.buildAutoSavePreDispose(sb) : undefined;
      return this.sandboxes.remove(id, "expired", pre);
    });
    return { host, port };
  }

  async close(): Promise<void> {
    // Stop the reaper first so it doesn't race with our explicit teardown.
    this.sandboxes.stop();
    // Tear down any in-flight agent runs first so their substrates don't outlive us.
    await Promise.all([...this.runs.values()].map((r) => r.agent.dispose().catch(() => {})));
    this.runs.clear();
    // Dispose every live sandbox in parallel.
    // Auto-save on graceful shutdown too, so a `systemctl stop` doesn't lose work.
    await Promise.all(this.sandboxes.list().map((s) => {
      const sb = this.sandboxes.get(s.sandboxId);
      const pre = sb ? this.buildAutoSavePreDispose(sb) : undefined;
      return this.sandboxes.remove(s.sandboxId, "shutdown", pre).catch(() => {});
    }));
    if (this.server) {
      await new Promise<void>((r) => {
        this.server!.close(() => r());
      });
      this.server = null;
    }
  }

  private wire(): void {
    // CORS — must come BEFORE auth so preflight OPTIONS doesn't get 401'd.
    // allowHeaders includes "authorization" so browsers can send Basic Auth.
    this.app.use(
      "*",
      cors({
        origin: "*",
        allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
        allowHeaders: ["content-type", "accept", "last-event-id", "authorization"],
        exposeHeaders: ["content-type"],
        maxAge: 86400,
      }),
    );

    // Basic Auth — enabled when API_AUTH_USER + API_AUTH_PASS are set in env.
    // Whitelisted paths skip auth:
    //   - /health           uptime monitoring should not require credentials
    //   - /slack/*          Slack signature verification is its own auth layer
    //                       (HMAC over the request body — see slack-bot.ts)
    //
    // When unset, the server logs a warning and accepts all requests, so this
    // stays backward-compatible until creds are configured.
    const authUser = process.env.API_AUTH_USER;
    const authPass = process.env.API_AUTH_PASS;
    if (authUser && authPass) {
      const expected = "Basic " + Buffer.from(`${authUser}:${authPass}`).toString("base64");
      const expectedBuf = Buffer.from(expected);
      this.app.use("*", async (c, next) => {
        const path = new URL(c.req.url).pathname;
        if (path === "/health" || path.startsWith("/slack/")) return next();
        const got = c.req.header("authorization") ?? "";
        if (got.length === expected.length) {
          const gotBuf = Buffer.from(got);
          try {
            if (timingSafeEqual(gotBuf, expectedBuf)) return next();
          } catch { /* length mismatch — fall through to 401 */ }
        }
        c.header("WWW-Authenticate", 'Basic realm="ComputerAgent"');
        return c.json({ error: { code: "UNAUTHORIZED" } }, 401);
      });
      console.log("[auth] Basic Auth ENABLED (user=" + authUser + ")");
    } else {
      console.warn("[auth] Basic Auth DISABLED — set API_AUTH_USER + API_AUTH_PASS env vars to enable.");
    }

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
        ...(body.policy ? { policy: body.policy as never } : {}),
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
          const otelTap = { sessionId: "", counter: 0 };
          for await (const ev of handle) {
            if (ev.kind === "ca_session_started" && !realSessionId) {
              realSessionId = ev.sessionId;
              this.runs.set(realSessionId, { agent, startedAt: Date.now() });
            }
            emitToAuditSink(this.opts.auditSink, otelTap, ev);
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

    // ── /sandboxes — warm substrate, multi-turn chat, TTL-bounded ─────────
    //
    // POST /sandboxes               create (substrate boots lazily on first chat)
    // POST /sandboxes/:id/chat      one turn of conversation (SSE)
    // GET  /sandboxes               list active sandboxes
    // GET  /sandboxes/:id           status snapshot
    // DELETE /sandboxes/:id         explicit dispose
    //
    // The reaper (started in listen()) walks the registry every reaperIntervalMs
    // and disposes any sandbox that's passed its idle or hard TTL.

    this.app.post("/sandboxes", async (c) => {
      const cfg = this.opts.sandbox ?? {};
      const max = cfg.maxConcurrent ?? 8;
      if (this.sandboxes.size() >= max) {
        return c.json({ error: { code: "TOO_MANY_SANDBOXES", active: this.sandboxes.size(), max } }, 429);
      }

      let body: SandboxBody;
      try {
        body = (await c.req.json()) as SandboxBody;
      } catch (err) {
        return c.json({ error: { code: "INVALID_JSON", message: (err as Error).message } }, 400);
      }
      // Reuse the run-body validator, minus the message check — a sandbox is
      // created BEFORE any turn arrives, so message lives on /chat.
      const v = validateSandboxBody(body);
      if (v) return c.json({ error: v }, 400);

      const runtimeResult = this.resolveRuntime(body.runtime);
      if (!runtimeResult.ok) return c.json({ error: runtimeResult.error }, 400);

      let resolvedTtl: { idleTtlMs: number; ttlMs: number };
      try {
        resolvedTtl = resolveSandboxTtl(body.idleTtlMs, body.ttlMs, cfg);
      } catch (err) {
        return c.json({ error: { code: "INVALID_TTL", message: (err as Error).message } }, 400);
      }

      const sandboxId = `sbx_${randomUUID().slice(0, 12)}`;
      const sessionId = body.sessionId ?? sandboxId;
      const now = new Date();

      // Hoist defaults that we know any harness needs. Mirrors the /run path.
      const envs = { ...this.opts.defaultEnvs, ...body.envs };
      if (!envs.ANTHROPIC_API_KEY && body.harness !== "gitagent") {
        const fromHost = process.env.ANTHROPIC_API_KEY;
        if (fromHost) envs.ANTHROPIC_API_KEY = fromHost;
      }

      const source = applyGitToken(normalizeSource(body.source), body.gitToken);
      // Build the agent but DO NOT call chat() yet — that's the substrate boot
      // signal. The first POST /sandboxes/:id/chat triggers it. Per-call
      // timeoutMs = sandbox.ttlMs + 30s grace so E2B's external 5m default
      // doesn't pre-empt our own TTL. Non-e2b substrates ignore the arg.
      const substrateTimeoutMs = resolvedTtl.ttlMs + 30_000;
      const agent = new ComputerAgent({
        source,
        harness: body.harness as never,
        runtime: runtimeResult.factory({ timeoutMs: substrateTimeoutMs }),
        envs,
        sessionId,
        ...(body.options ? { options: body.options } : {}),
        ...(body.model ? { model: body.model } : {}),
        ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
        ...(body.baseUrl ? { baseUrl: body.baseUrl } : {}),
        ...(body.debug ? { debug: true } : {}),
        ...(body.sessionStore ? { sessionStore: body.sessionStore as never } : {}),
        ...(body.policy ? { policy: body.policy as never } : {}),
        ...(body.attachments && body.attachments.length > 0 ? { attachments: body.attachments } : {}),
      });

      const sandbox: LiveSandbox = {
        id: sandboxId,
        sessionId,
        agent,
        state: "booting",
        createdAt: now,
        lastActivityAt: now,
        expiresAt: new Date(now.getTime() + resolvedTtl.ttlMs),
        idleExpiresAt: new Date(now.getTime() + resolvedTtl.idleTtlMs),
        turnCount: 0,
        usage: {},
        currentTurn: null,
        config: redactSandboxConfig(body),
        idleTtlMs: resolvedTtl.idleTtlMs,
        ttlMs: resolvedTtl.ttlMs,
        firstChatSeen: false,
        bootDeadlineAt: new Date(now.getTime() + (cfg.bootDeadlineMs ?? 60_000)),
        ...(body.autoSave ? { autoSave: { stateStoreKind: body.autoSave.stateStore.kind, stateStoreOptions: body.autoSave.stateStore.options } } : {}),
      };
      this.sandboxes.insert(sandbox);

      return c.json({
        sandboxId,
        sessionId,
        state: sandbox.state,
        createdAt: sandbox.createdAt,
        expiresAt: sandbox.expiresAt,
        idleExpiresAt: sandbox.idleExpiresAt,
        idleTtlMs: sandbox.idleTtlMs,
        ttlMs: sandbox.ttlMs,
      }, 201);
    });

    this.app.get("/sandboxes", (c) => {
      return c.json({ sandboxes: this.sandboxes.list() });
    });

    this.app.get("/sandboxes/:id", (c) => {
      const sb = this.sandboxes.get(c.req.param("id"));
      if (!sb) return c.json({ error: { code: "NOT_FOUND" } }, 404);
      return c.json(summarize(sb));
    });

    // GET /sandboxes/:id/workdir?depth=<n> — list the sandbox workdir tree.
    // Used by the Slack bot to diff before/after a turn and auto-attach any
    // deliverable files the agent produced.
    this.app.get("/sandboxes/:id/workdir", async (c) => {
      const sb = this.sandboxes.get(c.req.param("id"));
      if (!sb) return c.json({ error: { code: "NOT_FOUND" } }, 404);
      if (sb.state === "expired" || sb.state === "disposed") {
        return c.json({ error: { code: "GONE" } }, 410);
      }
      const depthRaw = Number(c.req.query("depth") ?? "3");
      const depth = Number.isFinite(depthRaw) ? Math.min(Math.max(depthRaw, 1), 8) : 3;
      // Ensure the session exists (boots substrate + clones the GAP repo) so the
      // listing reflects the real baseline — including repo files. Without this,
      // a pre-turn snapshot of a fresh sandbox returns empty, and the caller's
      // before/after diff would flag every cloned repo file as "new".
      try {
        await sb.agent.ensureSession();
      } catch {
        return c.json({ entries: [] });
      }
      const entries = await sb.agent.listWorkdir({ depth });
      return c.json({ entries });
    });

    // GET /sandboxes/:id/artifact?path=<path> — fetch a workdir file from a live sandbox.
    // Used by the Slack bot to grab agent-generated files (PDFs, PPTs, CSVs, …) and
    // re-upload them as Slack file attachments.
    this.app.get("/sandboxes/:id/artifact", async (c) => {
      const sb = this.sandboxes.get(c.req.param("id"));
      if (!sb) return c.json({ error: { code: "NOT_FOUND" } }, 404);
      if (sb.state === "expired" || sb.state === "disposed") {
        return c.json({ error: { code: "GONE" } }, 410);
      }
      const path = c.req.query("path");
      if (!path) return c.json({ error: { code: "MISSING_PATH" } }, 400);
      const bytes = await sb.agent.fetchArtifact(path);
      if (!bytes) return c.json({ error: { code: "NOT_FOUND", path } }, 404);
      return new Response(new Uint8Array(bytes), {
        headers: { "Content-Type": "application/octet-stream" },
      });
    });

    this.app.delete("/sandboxes/:id", async (c) => {
      const id = c.req.param("id");
      const sb = this.sandboxes.get(id);
      if (!sb) return c.json({ error: { code: "NOT_FOUND" } }, 404);
      // Capture usage BEFORE disposing — the registry removal nulls the agent.
      const finalUsage = sb.usage;
      const turnCount = sb.turnCount;
      const pre = this.buildAutoSavePreDispose(sb);
      await this.sandboxes.remove(id, "explicit", pre);
      return c.json({ ok: true, sandboxId: id, finalUsage, turnCount, autoSaved: Boolean(sb.autoSave) });
    });

    this.app.post("/sandboxes/:id/chat", async (c) => {
      const id = c.req.param("id");
      const sb = this.sandboxes.get(id);
      if (!sb) return c.json({ error: { code: "NOT_FOUND" } }, 404);
      if (sb.state === "expired" || sb.state === "disposed") {
        return c.json({ error: { code: "GONE", state: sb.state } }, 410);
      }
      if (sb.state === "restoring") {
        return c.json({ error: { code: "RESTORING", message: "Sandbox is being restored from snapshot. Retry in a moment." } }, 409);
      }
      if (sb.state === "busy" && sb.currentTurn) {
        return c.json({
          error: {
            code: "BUSY",
            message: "Sandbox is already serving a chat turn. Wait for ca_done on the other stream.",
            currentTurnStartedAt: sb.currentTurn.startedAt,
          },
        }, 409);
      }

      let body: SandboxChatBody;
      try {
        body = (await c.req.json()) as SandboxChatBody;
      } catch (err) {
        return c.json({ error: { code: "INVALID_JSON", message: (err as Error).message } }, 400);
      }
      if (!body.message) {
        return c.json({ error: { code: "MISSING_MESSAGE", message: "message is required" } }, 400);
      }

      // Reserve the slot synchronously so a concurrent POST sees state=busy.
      sb.state = "busy";
      sb.currentTurn = { startedAt: new Date() };
      sb.firstChatSeen = true;
      sb.lastActivityAt = new Date();

      // Materialize per-turn attachments (e.g. files the user uploaded in Slack)
      // into the workdir BEFORE the agent runs, so the agent can read them.
      if (body.attachments && body.attachments.length > 0) {
        try {
          await sb.agent.ensureSession();
          for (const a of body.attachments) {
            const bytes = a.encoding === "base64"
              ? Buffer.from(a.content, "base64")
              : Buffer.from(a.content, "utf8");
            await sb.agent.writeArtifact(a.path, bytes);
          }
        } catch (err) {
          sb.state = "ready";
          sb.currentTurn = undefined;
          return c.json({ error: { code: "ATTACHMENT_WRITE_FAILED", message: (err as Error).message } }, 500);
        }
      }

      return streamSSE(c, async (stream) => {
        // IMPORTANT: stream.onAbort must NOT dispose the sandbox. The substrate
        // is shared across turns — only DELETE or TTL fires dispose. We just
        // mark the turn complete from the server's perspective; the for-await
        // below sees stream backpressure / write errors and exits.
        let clientGone = false;
        stream.onAbort(() => { clientGone = true; });

        try {
          // The SDK accepts the same `message` shape /run uses.
          const handle = sb.agent.chat(body.message as never);
          const otelTap = { sessionId: sb.sessionId, counter: 0 };
          for await (const ev of handle) {
            if (clientGone) break;
            emitToAuditSink(this.opts.auditSink, otelTap, ev);
            await stream.writeSSE({ event: ev.kind, data: JSON.stringify(ev) }).catch(() => { clientGone = true; });
            if (ev.kind === "ca_usage_snapshot") {
              // The snapshot is incremental for the current turn; merge into
              // cumulative usage. The SDK's `handle.getUsage()` would give us
              // the same value but reading the event payload avoids the extra
              // method call.
              const u = (ev as { payload?: typeof sb.usage }).payload ?? {};
              mergeUsage(sb.usage, u);
            }
            if (ev.kind === "ca_session_ended") break;
          }
          if (!clientGone) {
            const finalUsage = handle.getUsage();
            mergeUsage(sb.usage, finalUsage);
            await stream.writeSSE({
              event: "ca_done",
              data: JSON.stringify({ sandboxId: id, sessionId: sb.sessionId, turn: sb.turnCount + 1, usage: finalUsage }),
            }).catch(() => {});
          }
        } catch (err) {
          // Stream the error to the client (if connected), but keep the sandbox
          // alive for the next turn — the agent may be in a recoverable state.
          // If the failure is fatal, the next chat() will surface the same
          // problem; either way it's the client's call whether to DELETE.
          if (!clientGone) {
            await stream.writeSSE({
              event: "ca_error",
              data: JSON.stringify({ message: err instanceof Error ? err.message : String(err) }),
            }).catch(() => {});
          }
        } finally {
          // Reset turn state. Refresh the idle timer ONLY if the sandbox
          // hasn't been reaped underneath us by the hard cap mid-stream.
          const stillAlive = this.sandboxes.get(id);
          if (stillAlive) {
            stillAlive.turnCount += 1;
            stillAlive.lastActivityAt = new Date();
            stillAlive.idleExpiresAt = new Date(Date.now() + stillAlive.idleTtlMs);
            stillAlive.currentTurn = null;
            stillAlive.state = "ready";
          }
        }
      });
    });

    // ── Heartbeat (Wedge 1.13) ────────────────────────────────────────────
    //
    // Cheap auto-warm. The client (typically the browser) fires this every
    // few seconds while the user is composing a message so the idle TTL
    // doesn't kill the substrate mid-typing. No LLM round-trip, just a
    // touch on idleExpiresAt.
    this.app.post("/sandboxes/:id/heartbeat", (c) => {
      const sb = this.sandboxes.get(c.req.param("id"));
      if (!sb) return c.json({ error: { code: "NOT_FOUND" } }, 404);
      if (sb.state === "expired" || sb.state === "disposed") {
        return c.json({ error: { code: "GONE", state: sb.state } }, 410);
      }
      // Refresh even when busy — idle clock is moot during busy, but the
      // contract is "ping keeps the sandbox alive". `lastActivityAt` is
      // updated for the dashboard.
      sb.idleExpiresAt = new Date(Date.now() + sb.idleTtlMs);
      sb.lastActivityAt = new Date();
      return c.json({
        sandboxId: sb.id,
        state: sb.state,
        idleExpiresAt: sb.idleExpiresAt,
        expiresAt: sb.expiresAt,
      });
    });

    // ── Snapshot (Wedge 1.13) ─────────────────────────────────────────────
    //
    // POST /sandboxes/:id/snapshot — capture the live workdir + metadata to
    // the chosen state store. Reject during busy (no consistent snapshot
    // mid-chat). The workdir walks via the SDK's listWorkdir + fetchArtifact;
    // each file becomes a tar-stream entry; the whole thing is gzipped and
    // handed to store.save().
    this.app.post("/sandboxes/:id/snapshot", async (c) => {
      const id = c.req.param("id");
      const sb = this.sandboxes.get(id);
      if (!sb) return c.json({ error: { code: "NOT_FOUND" } }, 404);
      if (sb.state === "busy") {
        return c.json({ error: { code: "BUSY", message: "Cannot snapshot while a chat turn is in flight." } }, 409);
      }
      if (sb.state === "expired" || sb.state === "disposed" || sb.state === "restoring") {
        return c.json({ error: { code: "GONE", state: sb.state } }, 410);
      }
      let body: { stateStore?: { kind: string; options?: unknown }; snapshotId?: string };
      try {
        body = (await c.req.json().catch(() => ({}))) as never;
      } catch {
        body = {};
      }
      const storeKind = body.stateStore?.kind ?? this.opts.defaultStateStore ?? Object.keys(this.stateStores)[0];
      const builder = this.stateStores[storeKind];
      if (!builder) {
        return c.json({ error: { code: "UNKNOWN_STATE_STORE", available: Object.keys(this.stateStores) } }, 400);
      }
      const store = builder(body.stateStore?.options);
      try {
        const result = await this.takeSnapshot(sb, store, body.snapshotId);
        return c.json(result);
      } catch (err) {
        return c.json({ error: { code: "SNAPSHOT_FAILED", message: err instanceof Error ? err.message : String(err) } }, 500);
      }
    });

    // GET /snapshots — list snapshots in a backend. Lives at /snapshots
    // (not /sandboxes/snapshots) to avoid routing collision with
    // /sandboxes/:id, since Hono's router treats them as ambiguous when
    // both end with the same segment count.
    // Query string carries kind + options (flat). e.g.
    //   /snapshots?stateStore=s3&bucket=foo&prefix=tenant-a/
    this.app.get("/snapshots", async (c) => {
      const q = c.req.query();
      const storeKind = q.stateStore ?? this.opts.defaultStateStore ?? Object.keys(this.stateStores)[0];
      const builder = this.stateStores[storeKind];
      if (!builder) return c.json({ error: { code: "UNKNOWN_STATE_STORE", available: Object.keys(this.stateStores) } }, 400);
      const opts = optsFromQuery(q);
      const store = builder(opts);
      const filter: SnapshotFilter = {};
      if (q.sourceSandboxId) (filter as { sourceSandboxId: string }).sourceSandboxId = q.sourceSandboxId;
      if (q.limit) (filter as { limit: number }).limit = Number(q.limit);
      try {
        const snaps = await store.list(filter);
        return c.json({ snapshots: snaps });
      } catch (err) {
        return c.json({ error: { code: "LIST_FAILED", message: err instanceof Error ? err.message : String(err) } }, 500);
      }
    });

    // DELETE /snapshots/:id — same query-shape as list.
    this.app.delete("/snapshots/:id", async (c) => {
      const q = c.req.query();
      const storeKind = q.stateStore ?? this.opts.defaultStateStore ?? Object.keys(this.stateStores)[0];
      const builder = this.stateStores[storeKind];
      if (!builder) return c.json({ error: { code: "UNKNOWN_STATE_STORE", available: Object.keys(this.stateStores) } }, 400);
      const store = builder(optsFromQuery(q));
      try {
        await store.delete(c.req.param("id"));
        return c.json({ ok: true });
      } catch (err) {
        return c.json({ error: { code: "DELETE_FAILED", message: err instanceof Error ? err.message : String(err) } }, 500);
      }
    });

    // ── Restore (Wedge 1.13) ──────────────────────────────────────────────
    //
    // POST /sandboxes/restore — two modes via `target`:
    //   target: "new" (default) → create a fresh sandbox from the snapshot.
    //   target: "<existingId>"  → dispose target's substrate + swap in a new
    //                              ComputerAgent built from the snapshot.
    //                              Same sandboxId is preserved.
    this.app.post("/sandboxes/restore", async (c) => {
      let body: {
        snapshotId: string;
        stateStore: { kind: string; options?: unknown };
        target?: string;
        idleTtlMs?: number;
        ttlMs?: number;
        runtime?: string;
        envs?: Record<string, string>;
        autoSave?: { stateStore: { kind: string; options?: unknown } };
      };
      try { body = (await c.req.json()) as never; }
      catch (err) {
        return c.json({ error: { code: "INVALID_JSON", message: (err as Error).message } }, 400);
      }
      if (!body.snapshotId || !body.stateStore?.kind) {
        return c.json({ error: { code: "INVALID_BODY", message: "snapshotId + stateStore.kind required" } }, 400);
      }
      const builder = this.stateStores[body.stateStore.kind];
      if (!builder) return c.json({ error: { code: "UNKNOWN_STATE_STORE", available: Object.keys(this.stateStores) } }, 400);
      const store = builder(body.stateStore.options);

      const snap = await store.load(body.snapshotId);
      if (!snap) return c.json({ error: { code: "NOT_FOUND", snapshotId: body.snapshotId } }, 404);

      // Same gate as POST /sandboxes — if the snapshot was taken with
      // harness=deepagents (only possible from before the gate was added),
      // refuse to restore. The conversation wouldn't survive anyway.
      if ((snap.config as { harness?: string } | undefined)?.harness === "deepagents") {
        return c.json({
          error: {
            code: "HARNESS_NOT_SUPPORTED",
            message: "Restore refused: snapshot's harness is deepagents, which the warm-sandbox surface does not support. The captured workdir survives but the conversation does not. Use POST /run with attachments if you need the workdir bytes only.",
          },
        }, 400);
      }

      try {
        if (!body.target || body.target === "new") {
          // Fresh slot. Reconstruct a SandboxBody from the snapshot's config
          // plus caller overrides, then go through the existing create flow.
          const restored = await this.createRestoredSandbox(snap, body);
          return c.json({ ...restored, restored: true, fromSnapshotId: snap.snapshotId }, 201);
        }
        // Replace-in-place.
        const target = this.sandboxes.get(body.target);
        if (!target) return c.json({ error: { code: "NOT_FOUND", target: body.target } }, 404);
        if (target.state === "busy") {
          return c.json({ error: { code: "BUSY", message: "Cannot restore while a chat turn is in flight" } }, 409);
        }
        if (target.state === "expired" || target.state === "disposed") {
          return c.json({ error: { code: "GONE", state: target.state } }, 410);
        }
        await this.replaceAgentInPlace(target, snap, body);
        return c.json({
          sandboxId: target.id,
          sessionId: target.sessionId,
          state: target.state,
          createdAt: target.createdAt,
          expiresAt: target.expiresAt,
          idleExpiresAt: target.idleExpiresAt,
          restored: true,
          fromSnapshotId: snap.snapshotId,
        }, 200);
      } catch (err) {
        return c.json({ error: { code: "RESTORE_FAILED", message: err instanceof Error ? err.message : String(err) } }, 500);
      }
    });
  }

  /**
   * Build the pre-dispose hook that snapshots a sandbox to its configured
   * auto-save store before tear-down. Returns undefined if the sandbox
   * doesn't have auto-save configured. Errors inside the returned hook
   * are swallowed by `SandboxRegistry.remove()` — dispose proceeds either way.
   */
  private buildAutoSavePreDispose(sb: LiveSandbox): ((sb: LiveSandbox) => Promise<void>) | undefined {
    if (!sb.autoSave) return undefined;
    return async (sandbox) => {
      const builder = this.stateStores[sandbox.autoSave!.stateStoreKind];
      if (!builder) {
        // eslint-disable-next-line no-console
        console.error(`[sandbox] ${sandbox.id} autoSave: unknown store '${sandbox.autoSave!.stateStoreKind}'`);
        return;
      }
      const store = builder(sandbox.autoSave!.stateStoreOptions);
      // Stable id so a sandbox that gets reaped+restored has a discoverable
      // trail. Includes timestamp for ordering when a sandbox is auto-saved
      // multiple times across its lifetime (e.g. shutdown then restart).
      const snapshotId = `snap_${sandbox.id}_${Date.now()}`;
      const r = await this.takeSnapshot(sandbox, store, snapshotId);
      // eslint-disable-next-line no-console
      console.log(`[sandbox] ${sandbox.id} auto-saved → ${r.snapshotId} (${r.fileCount} files, ${r.sizeBytes}B)`);
    };
  }

  /**
   * Walk the live agent's workdir, build a gzipped tarball of all files,
   * and persist via the supplied store. Assumes the caller already checked
   * sandbox is not busy. Throws on any walk / tar / store error.
   */
  private async takeSnapshot(
    sb: LiveSandbox,
    store: StateStore,
    snapshotId?: string,
  ): Promise<{ snapshotId: string; sizeBytes: number; takenAt: Date; fileCount: number }> {
    const id = snapshotId ?? `snap_${randomUUID().slice(0, 12)}`;
    // listWorkdir caps depth at 8 server-side (path-jail). For deeper trees
    // this is the practical limit; document if it bites.
    const entries = await sb.agent.listWorkdir({ depth: 8 });
    const files = entries.filter((e) => e.type === "file");

    // tar-stream's pack() writes entries programmatically; we then pipe
    // through gzip. The whole tarball lives in memory — fine for typical
    // agent workdirs (<10MB), would need streaming for larger.
    const pack = tar.pack();
    let fileCount = 0;
    // Drive the pack stream from the file list.
    const writes = (async () => {
      for (const f of files) {
        const bytes = await sb.agent.fetchArtifact(f.path);
        if (!bytes) continue;
        await new Promise<void>((resolve, reject) => {
          pack.entry({ name: f.path, size: bytes.byteLength }, Buffer.from(bytes), (err) => {
            if (err) reject(err); else resolve();
          });
        });
        fileCount += 1;
      }
      pack.finalize();
    })();
    // Collect the gzipped output.
    const chunks: Buffer[] = [];
    const collect = (async () => {
      for await (const chunk of pack as unknown as AsyncIterable<Buffer>) {
        chunks.push(chunk);
      }
    })();
    await Promise.all([writes, collect]);
    const tarBytes = Buffer.concat(chunks);
    const gzipped = gzipSync(tarBytes);

    // Build the SessionStoreRef from the sandbox's original config — if a
    // sessionStore was wired, restoring with the same sessionId replays the
    // engine's conversation memory on first chat.
    const cfg = sb.config as { sessionStore?: { kind: string; options?: unknown } };
    const sessionStoreRef: SessionStoreRef | undefined = cfg.sessionStore
      ? { kind: cfg.sessionStore.kind, options: cfg.sessionStore.options, sessionId: sb.sessionId }
      : undefined;

    const snap: SandboxSnapshot = {
      snapshotId: id,
      sourceSandboxId: sb.id,
      sourceSessionId: sb.sessionId,
      takenAt: new Date(),
      config: sb.config,
      turnCount: sb.turnCount,
      usage: sb.usage,
      ...(sessionStoreRef ? { sessionStoreRef } : {}),
      workdirTar: gzipped,
      workdirBytes: gzipped.byteLength,
      workdirFileCount: fileCount,
    };
    const result = await store.save(snap);
    return { snapshotId: result.snapshotId, sizeBytes: result.sizeBytes, takenAt: snap.takenAt, fileCount };
  }

  /**
   * Create a NEW sandbox seeded with the snapshot's workdir + sessionStore
   * (if any). Used by POST /sandboxes/restore when target === "new" (or
   * unset). Inserts into the registry and returns the same payload shape
   * as POST /sandboxes.
   */
  private async createRestoredSandbox(
    snap: SandboxSnapshot,
    overrides: { idleTtlMs?: number; ttlMs?: number; runtime?: string; envs?: Record<string, string>; autoSave?: SandboxBody["autoSave"] },
  ): Promise<{ sandboxId: string; sessionId: string; state: SandboxState; createdAt: Date; expiresAt: Date; idleExpiresAt: Date }> {
    const cfg = snap.config as Partial<SandboxBody>;
    const sandboxId = `sbx_${randomUUID().slice(0, 12)}`;
    const sessionId = snap.sessionStoreRef?.sessionId ?? sandboxId;
    const attachments = await tarToAttachments(snap.workdirTar);
    const runtime = overrides.runtime ?? cfg.runtime;
    const runtimeResult = this.resolveRuntime(runtime);
    if (!runtimeResult.ok) throw new Error(`UNKNOWN_RUNTIME: ${runtime}`);

    const envs = { ...this.opts.defaultEnvs, ...cfg.envs, ...overrides.envs };
    if (!envs.ANTHROPIC_API_KEY && cfg.harness !== "gitagent") {
      const fromHost = process.env.ANTHROPIC_API_KEY;
      if (fromHost) envs.ANTHROPIC_API_KEY = fromHost;
    }

    const sessionStore = snap.sessionStoreRef
      ? { kind: snap.sessionStoreRef.kind, options: snap.sessionStoreRef.options }
      : (cfg.sessionStore as { kind: string; options?: unknown } | undefined);

    // Resolve TTL first so we can pass the e2b timeout when building the substrate.
    const now = new Date();
    const sandboxCfg = this.opts.sandbox ?? {};
    const ttl = resolveSandboxTtl(overrides.idleTtlMs ?? (cfg.idleTtlMs as number | undefined), overrides.ttlMs ?? (cfg.ttlMs as number | undefined), sandboxCfg);

    const agent = new ComputerAgent({
      source: cfg.source as never,
      harness: cfg.harness as never,
      runtime: runtimeResult.factory({ timeoutMs: ttl.ttlMs + 30_000 }),
      envs,
      sessionId,
      ...(cfg.options ? { options: cfg.options } : {}),
      ...(cfg.model ? { model: cfg.model } : {}),
      ...(cfg.temperature !== undefined ? { temperature: cfg.temperature } : {}),
      ...(cfg.baseUrl ? { baseUrl: cfg.baseUrl } : {}),
      ...(cfg.debug ? { debug: true } : {}),
      ...(sessionStore ? { sessionStore: sessionStore as never } : {}),
      attachments,
    });

    const autoSave = overrides.autoSave ?? cfg.autoSave;
    const sandbox: LiveSandbox = {
      id: sandboxId,
      sessionId,
      agent,
      state: "booting",
      createdAt: now,
      lastActivityAt: now,
      expiresAt: new Date(now.getTime() + ttl.ttlMs),
      idleExpiresAt: new Date(now.getTime() + ttl.idleTtlMs),
      turnCount: 0,
      usage: {},
      currentTurn: null,
      config: snap.config,
      idleTtlMs: ttl.idleTtlMs,
      ttlMs: ttl.ttlMs,
      firstChatSeen: false,
      bootDeadlineAt: new Date(now.getTime() + (sandboxCfg.bootDeadlineMs ?? 60_000)),
      ...(autoSave ? { autoSave: { stateStoreKind: autoSave.stateStore.kind, stateStoreOptions: autoSave.stateStore.options } } : {}),
    };
    this.sandboxes.insert(sandbox);
    return {
      sandboxId,
      sessionId,
      state: sandbox.state,
      createdAt: sandbox.createdAt,
      expiresAt: sandbox.expiresAt,
      idleExpiresAt: sandbox.idleExpiresAt,
    };
  }

  /**
   * Replace the agent inside an existing sandbox slot with a fresh agent
   * built from `snap`. Used by POST /sandboxes/restore when target points
   * at an existing sandboxId. The substrate is disposed + rebooted; the
   * sandboxId stays stable. Caller has already verified state is not
   * busy/expired/disposed.
   */
  private async replaceAgentInPlace(
    sb: LiveSandbox,
    snap: SandboxSnapshot,
    overrides: { idleTtlMs?: number; ttlMs?: number; runtime?: string; envs?: Record<string, string> },
  ): Promise<void> {
    const oldState = sb.state;
    sb.state = "restoring";
    try {
      const cfg = snap.config as Partial<SandboxBody>;
      const sessionId = snap.sessionStoreRef?.sessionId ?? sb.sessionId;
      const attachments = await tarToAttachments(snap.workdirTar);
      const runtime = overrides.runtime ?? cfg.runtime;
      const runtimeResult = this.resolveRuntime(runtime);
      if (!runtimeResult.ok) throw new Error(`UNKNOWN_RUNTIME: ${runtime}`);

      const envs = { ...this.opts.defaultEnvs, ...cfg.envs, ...overrides.envs };
      if (!envs.ANTHROPIC_API_KEY && cfg.harness !== "gitagent") {
        const fromHost = process.env.ANTHROPIC_API_KEY;
        if (fromHost) envs.ANTHROPIC_API_KEY = fromHost;
      }

      const sessionStore = snap.sessionStoreRef
        ? { kind: snap.sessionStoreRef.kind, options: snap.sessionStoreRef.options }
        : (cfg.sessionStore as { kind: string; options?: unknown } | undefined);

      // Build new agent BEFORE disposing old one so a build error doesn't
      // leave us with a torn-down substrate + no replacement. The new substrate
      // inherits the existing slot's remaining ttlMs window — that's what the
      // caller is paying for in terms of warmth.
      const inPlaceTimeoutMs = (overrides.ttlMs ?? sb.ttlMs) + 30_000;
      const newAgent = new ComputerAgent({
        source: cfg.source as never,
        harness: cfg.harness as never,
        runtime: runtimeResult.factory({ timeoutMs: inPlaceTimeoutMs }),
        envs,
        sessionId,
        ...(cfg.options ? { options: cfg.options } : {}),
        ...(cfg.model ? { model: cfg.model } : {}),
        ...(cfg.temperature !== undefined ? { temperature: cfg.temperature } : {}),
        ...(cfg.baseUrl ? { baseUrl: cfg.baseUrl } : {}),
        ...(cfg.debug ? { debug: true } : {}),
        ...(sessionStore ? { sessionStore: sessionStore as never } : {}),
        attachments,
      });
      // Old substrate goes down.
      await sb.agent.dispose().catch(() => {});
      sb.agent = newAgent;
      sb.sessionId = sessionId;
      sb.turnCount = 0;
      sb.usage = {};
      sb.firstChatSeen = false;
      sb.lastActivityAt = new Date();
      // Refresh idle clock so the freshly-restored sandbox doesn't get
      // reaped immediately if the user left it idle pre-restore.
      const idle = overrides.idleTtlMs ?? sb.idleTtlMs;
      sb.idleExpiresAt = new Date(Date.now() + idle);
      sb.state = "ready";
    } catch (err) {
      sb.state = oldState === "restoring" ? "ready" : oldState;
      throw err;
    }
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
      const otelTap = { sessionId: sessionId ?? "", counter: 0 };
      for await (const ev of handle as AsyncIterable<HarnessEvent>) {
        emitToAuditSink(this.opts.auditSink, otelTap, ev);
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
      // If a cancel was requested, agent.dispose() typically surfaces as a
      // SIGTERM error here. Treat that as a clean "cancelled" outcome rather
      // than an unexpected error — the user asked for it.
      const status: TaskStatus = cancelRequested ? "cancelled" : "errored";
      await taskStore.updateStatus(taskId, status, {
        endedAt: new Date(),
        ...(cancelRequested ? {} : { error: err instanceof Error ? err.message : String(err) }),
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
    | { ok: true; factory: (opts?: { timeoutMs?: number }) => Substrate }
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

/** Accumulate per-turn usage deltas into the sandbox's running totals. */
function mergeUsage(
  target: LiveSandbox["usage"],
  src: Partial<LiveSandbox["usage"]> | undefined,
): void {
  if (!src) return;
  if (src.inputTokens != null) target.inputTokens = (target.inputTokens ?? 0) + src.inputTokens;
  if (src.outputTokens != null) target.outputTokens = (target.outputTokens ?? 0) + src.outputTokens;
  if (src.cacheCreationInputTokens != null) target.cacheCreationInputTokens = (target.cacheCreationInputTokens ?? 0) + src.cacheCreationInputTokens;
  if (src.cacheReadInputTokens != null) target.cacheReadInputTokens = (target.cacheReadInputTokens ?? 0) + src.cacheReadInputTokens;
  if (src.costUsd != null) target.costUsd = (target.costUsd ?? 0) + src.costUsd;
}

/**
 * Untar + ungzip a snapshot's `workdirTar` into the `attachments[]` shape
 * the harness server understands. The harness writes each entry into the
 * workdir via the existing path-jailed `writeBytes()` path, so we don't
 * need any new server-side write code.
 *
 * Entries under `.git/` are SKIPPED on restore: the loader recreates
 * `.git` cleanly from `source` (git clone), so re-applying snapshot
 * bytes is at best redundant and at worst fails on read-only pack files
 * (e.g. `.git/objects/pack/*.idx` are mode 0444 and EACCES on overwrite).
 * The snapshot still CAPTURES `.git` for fidelity; we just don't pour it
 * back over a freshly-cloned working tree.
 */
async function tarToAttachments(
  gzipped: Buffer,
): Promise<Array<{ path: string; content: string; encoding: "base64" }>> {
  const tarBytes = gunzipSync(gzipped);
  const extract = tar.extract();
  const out: Array<{ path: string; content: string; encoding: "base64" }> = [];
  const done = new Promise<void>((resolve, reject) => {
    extract.on("entry", (header, stream, next) => {
      const chunks: Buffer[] = [];
      stream.on("data", (c: Buffer) => chunks.push(c));
      stream.on("end", () => {
        if (header.type === "file" && !header.name.startsWith(".git/") && header.name !== ".git") {
          out.push({
            path: header.name,
            content: Buffer.concat(chunks).toString("base64"),
            encoding: "base64",
          });
        }
        next();
      });
      stream.on("error", reject);
      stream.resume();
    });
    extract.on("finish", () => resolve());
    extract.on("error", reject);
  });
  Readable.from(tarBytes).pipe(extract);
  await done;
  return out;
}

/**
 * Flatten the Hono query-string object back into a plain options bag for
 * a state-store builder. Used by GET /sandboxes/snapshots etc. — clients
 * pass bucket/prefix/region as flat query params; the builder expects
 * them merged into S3StateStoreOptions. Drops the reserved `stateStore`
 * + filter keys.
 */
function optsFromQuery(q: Record<string, string>): Record<string, unknown> {
  const reserved = new Set(["stateStore", "sourceSandboxId", "limit", "since"]);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(q)) {
    if (reserved.has(k)) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Validator for POST /sandboxes — same as run-body minus the message check
 * (sandboxes are message-less until /chat). idleTtlMs/ttlMs validity is
 * checked separately by `resolveSandboxTtl`.
 */
function validateSandboxBody(body: unknown): { code: string; message: string } | undefined {
  if (!body || typeof body !== "object") return { code: "INVALID_BODY", message: "body must be a JSON object" };
  const b = body as Record<string, unknown>;
  if (!b.source) return { code: "MISSING_SOURCE", message: "source is required" };
  if (!b.harness || typeof b.harness !== "string") {
    return { code: "MISSING_HARNESS", message: "harness is required (e.g. 'claude-agent-sdk')" };
  }
  // ── Warm-sandbox gate (Wedge 1.13 follow-up) ───────────────────────────
  // Deepagents' LangGraph checkpointer is fully in-memory and isn't bridged
  // to the SessionStore protocol the way claude-agent-sdk + gitagent are.
  // That means:
  //   - multi-turn within ONE warm sandbox WORKS (verified, in-memory state
  //     persists across chat() calls)
  //   - BUT snapshot → restore loses the conversation
  // Cross-harness suite verified this end-to-end. Until engine-deepagents
  // bridges its checkpointer (a substantial follow-up wedge), the warm
  // sandbox surface refuses deepagents at the door. Users get /run + /tasks
  // for one-shot work, which doesn't depend on the missing bridge.
  if (b.harness === "deepagents") {
    return {
      code: "HARNESS_NOT_SUPPORTED",
      message: "Warm sandboxes are not yet supported for harness=deepagents. The LangGraph checkpointer state isn't bridged to SessionStore, so conversation is lost on snapshot/restore. Use POST /run or POST /tasks for deepagents one-shot work.",
    };
  }
  return undefined;
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

  const substrates: Record<string, (opts?: { timeoutMs?: number }) => Substrate> = {
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
    // Forward per-call timeoutMs (warm sandboxes pass ttlMs + grace so E2B's
    // 5min default idle-killer doesn't bury a longer-lived sandbox). For /run
    // + /tasks the arg is undefined and E2B uses its built-in default.
    substrates.e2b = (opts) => new E2BSubstrate({
      apiKey: process.env.E2B_API_KEY,
      ...(opts?.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
    });
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

  // State store registry — `s3` registers when S3_BUCKET is set; AWS creds
  // resolved via the SDK's default chain (env, instance role, etc.).
  const stateStores: Record<string, StateStoreBuilder> = {};
  if (process.env.S3_BUCKET) {
    stateStores.s3 = s3StateStoreBuilder({
      bucket: process.env.S3_BUCKET,
      ...(process.env.AWS_REGION ? { region: process.env.AWS_REGION } : {}),
      ...(process.env.S3_PREFIX ? { prefix: process.env.S3_PREFIX } : {}),
      ...(process.env.S3_ENDPOINT ? { endpoint: process.env.S3_ENDPOINT } : {}),
    });
  }
  const defaultStateStore = process.env.DEFAULT_STATE_STORE
    ?? (stateStores.s3 ? "s3" : "memory");

  // Sandbox pool config — every knob is env-overridable so the deployment
  // can dial idle vs hard caps to match its substrate economics (bwrap is
  // cheap, e2b is per-minute). Defaults are conservative: 10m idle, 30m hard.
  const intEnv = (key: string, fallback: number): number => {
    const v = process.env[key];
    if (!v) return fallback;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  // OTel SDK spec: comma-separated `key=value` pairs.
  const parseOtlpHeaders = (raw: string | undefined): Record<string, string> | undefined => {
    if (!raw) return undefined;
    const out: Record<string, string> = {};
    for (const pair of raw.split(",")) {
      const idx = pair.indexOf("=");
      if (idx <= 0) continue;
      const k = pair.slice(0, idx).trim();
      const v = pair.slice(idx + 1).trim();
      if (k) out[k] = v;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  };
  const sandboxCfg = {
    maxConcurrent: intEnv("SANDBOX_MAX_CONCURRENT", 8),
    defaultIdleTtlMs: intEnv("SANDBOX_DEFAULT_IDLE_TTL_MS", 10 * 60_000),
    defaultTtlMs: intEnv("SANDBOX_DEFAULT_TTL_MS", 30 * 60_000),
    maxIdleTtlMs: intEnv("SANDBOX_MAX_IDLE_TTL_MS", 30 * 60_000),
    maxTtlMs: intEnv("SANDBOX_MAX_TTL_MS", 120 * 60_000),
    reaperIntervalMs: intEnv("SANDBOX_REAPER_INTERVAL_MS", 5_000),
    bootDeadlineMs: intEnv("SANDBOX_BOOT_DEADLINE_MS", 60_000),
  };

  // Optional: in-process Anthropic ↔ OpenAI translator proxy. When
  // LYZR_PROXY_ENABLED=1 we boot @computeragent/llm-proxy-openai on
  // 127.0.0.1:<port> so claude-agent-sdk / deepagents can target Lyzr (or
  // any OpenAI-Chat-Completions backend) by setting `envs.ANTHROPIC_BASE_URL`
  // = "http://127.0.0.1:<port>" on a /run or sandbox chat. Substrates
  // running on the same host can reach the proxy via loopback (bwrap and
  // local share the host's network namespace; e2b cannot — it would need
  // a publicly routable proxy URL, out of scope here).
  //
  // gitagent doesn't need this proxy at all — gitclaw natively speaks OpenAI
  // Chat Completions via GITCLAW_MODEL_BASE_URL + provider:model@baseUrl.
  let lyzrProxyHandle: { port: number; close: () => Promise<void> } | null = null;
  if (process.env.LYZR_PROXY_ENABLED === "1") {
    const { startProxy } = await import("@computeragent/llm-proxy-openai");
    const proxyToken = process.env.LYZR_UPSTREAM_TOKEN;
    if (!proxyToken) {
      console.error("[lyzr-proxy] LYZR_PROXY_ENABLED=1 but LYZR_UPSTREAM_TOKEN is not set — skipping");
    } else {
      lyzrProxyHandle = await startProxy({
        port: intEnv("LYZR_PROXY_PORT", 8788),
        upstream: {
          base: process.env.LYZR_UPSTREAM_BASE ?? "https://agent-dev.test.studio.lyzr.ai",
          path: process.env.LYZR_UPSTREAM_PATH ?? "/v4/chat/completions",
          token: proxyToken,
          ...(process.env.LYZR_UPSTREAM_MODEL ? { modelOverride: process.env.LYZR_UPSTREAM_MODEL } : {}),
        },
      });
    }
  }

  // Optional: OpenTelemetry. Boot the global tracer/meter/logger when
  // OTEL_EXPORTER_OTLP_ENDPOINT is set; the sink then forwards every
  // HarnessEvent emitted by /run, /tasks, and /sandboxes/:id/chat as
  // spec-compliant `gen_ai.*` spans + metrics. Disable by leaving
  // OTEL_EXPORTER_OTLP_ENDPOINT unset (sink stays null).
  //
  // OTEL_EXPORTER_OTLP_HEADERS (comma-separated `key=value`) is forwarded to
  // the exporter for backends that require auth on direct push — primarily
  // New Relic, where you set:
  //   OTEL_EXPORTER_OTLP_ENDPOINT=https://otlp.nr-data.net
  //   OTEL_EXPORTER_OTLP_HEADERS=api-key=<NEW_RELIC_LICENSE_KEY>
  let auditSink: AuditSink | undefined;
  if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
    const otlpHeaders = parseOtlpHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS);
    configureOtel({
      serviceName: process.env.OTEL_SERVICE_NAME ?? "computeragent-server",
      exporter: "otlp-http",
      endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
      ...(otlpHeaders ? { headers: otlpHeaders } : {}),
      sampleRate: Number(process.env.OTEL_SAMPLE_RATE ?? 1.0),
    });
    auditSink = new OtelAuditSink();
    console.log(
      `[otel] OTLP/HTTP exporter → ${process.env.OTEL_EXPORTER_OTLP_ENDPOINT}` +
        (otlpHeaders ? ` (auth: headers set)` : ""),
    );
  }

  const server = new ComputerAgentServer({
    host: process.env.HOST ?? "127.0.0.1",
    port: Number(process.env.PORT ?? 8787),
    defaultEnvs: Object.keys(defaultEnvs).length > 0 ? defaultEnvs : undefined,
    maxConcurrentRuns: 4,
    substrates,
    defaultRuntime: process.env.DEFAULT_RUNTIME ?? "local",
    ...(Object.keys(taskStores).length > 0 ? { taskStores } : {}),
    defaultTaskStore,
    ...(Object.keys(stateStores).length > 0 ? { stateStores } : {}),
    defaultStateStore,
    sandbox: sandboxCfg,
    ...(auditSink ? { auditSink } : {}),
  });

  // ── Optional: Slack bots — mount under /slack/{bot}/events.
  //
  // Two bots exposed when SLACK_BOTS_ENABLED=1:
  //   /slack/claudebot/events  → claude-agent-sdk + (optional) LYZR proxy
  //   /slack/gitagent/events   → gitagent direct
  //
  // Each bot maps a Slack thread to a warm /sandboxes instance with
  // autoSave → S3 so threads can be resumed days later. Bots missing env
  // config (TOKEN/SIGNING_SECRET/SOURCE) are skipped at boot, not fatal.
  let slackBotNames: string[] = [];
  if (process.env.SLACK_BOTS_ENABLED === "1") {
    if (!process.env.MONGO_URL) {
      console.error("[slack-bot] SLACK_BOTS_ENABLED=1 but MONGO_URL not set — Slack thread map needs mongo; skipping");
    } else {
      const [{ createSlackBotsApp, botsFromEnv }, { AgentLogStore }] = await Promise.all([
        import("./slack-bot.ts"),
        import("./agent-log-store.ts"),
      ]);
      const bots = botsFromEnv();
      if (bots.length === 0) {
        console.error("[slack-bot] SLACK_BOTS_ENABLED=1 but no bot has all of TOKEN+SIGNING_SECRET+SOURCE; skipping");
      } else {
        const caBase = `http://${process.env.HOST ?? "127.0.0.1"}:${Number(process.env.PORT ?? 8787)}`;
        const mongoUrl = process.env.MONGO_URL;
        const mongoDb = process.env.MONGO_DATABASE ?? "computeragent-test";
        const logStore = new AgentLogStore(mongoUrl, mongoDb);
        const slackApp = createSlackBotsApp({ caBase, mongoUrl, mongoDb, bots, logStore });
        server.mount(slackApp);
        slackBotNames = bots.map((b) => b.name);

        // NOTE: the AgentOS dashboard API + scheduler used to be mounted here.
        // They've moved to `packages/agentos-server` — a separate Express
        // process that talks back to this harness over CA_BASE (loopback HTTP).
        // To bring the dashboard up locally:
        //   pnpm --filter @computeragent/agentos-server dev
      }
    }
  }
  // Graceful shutdown — kill the proxy too when the main server stops.
  // Flush OTel exporters FIRST so in-flight spans land before sockets close.
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      void (async () => {
        if (auditSink) await shutdownOtel(2_000).catch(() => {});
        await lyzrProxyHandle?.close().catch(() => {});
        await server.close().catch(() => {});
        process.exit(0);
      })();
    });
  }
  const { host, port } = await server.listen();
  console.log(`ComputerAgentServer listening on http://${host}:${port}`);
  if (lyzrProxyHandle) {
    console.log(`Anthropic↔OpenAI proxy listening on http://127.0.0.1:${lyzrProxyHandle.port}`);
    console.log(`  → use envs.ANTHROPIC_BASE_URL=http://127.0.0.1:${lyzrProxyHandle.port} on /run for claude-agent-sdk + deepagents`);
  }
  if (slackBotNames.length > 0) {
    console.log(`Slack bots active: ${slackBotNames.join(", ")}`);
    for (const b of slackBotNames) {
      console.log(`  POST /slack/${b}/events  (set as Slack Request URL for the ${b} app)`);
    }
    console.log(`  GET  /slack/health          (mongo connectivity + bot list)`);
  }
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
  console.log("  POST /sandboxes                 body: {source, harness, runtime?, envs?, options?, model?, idleTtlMs?, ttlMs?, autoSave?}; returns 201 {sandboxId}");
  console.log("  POST /sandboxes/:id/chat        body: {message, attachments?}; SSE stream; 409 if busy");
  console.log("  POST /sandboxes/:id/heartbeat   refresh idle TTL without a chat; ~5ms");
  console.log("  POST /sandboxes/:id/snapshot    body: {stateStore: {kind, options?}, snapshotId?}; returns {snapshotId, sizeBytes, takenAt}");
  console.log("  POST /sandboxes/restore         body: {snapshotId, stateStore, target?: 'new'|'<id>'}; 201 new or 200 in-place");
  console.log("  GET  /sandboxes                 list active sandboxes");
  console.log("  GET  /sandboxes/:id             status snapshot");
  console.log("  DEL  /sandboxes/:id             dispose explicitly (runs autoSave if configured)");
  console.log("  GET  /snapshots                 ?stateStore=&bucket=&prefix=... — list snapshots");
  console.log("  DEL  /snapshots/:id             same query shape — delete a snapshot");
  console.log(`  sandbox TTLs: idle=${Math.round(sandboxCfg.defaultIdleTtlMs/1000)}s default / ${Math.round(sandboxCfg.maxIdleTtlMs/1000)}s max, hard=${Math.round(sandboxCfg.defaultTtlMs/1000)}s default / ${Math.round(sandboxCfg.maxTtlMs/1000)}s max, max ${sandboxCfg.maxConcurrent} concurrent`);
  console.log(`  defaultStateStore: ${defaultStateStore}  (registered: ${["memory", ...Object.keys(stateStores)].join(", ")})`);
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
