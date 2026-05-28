/**
 * AgentOS control-panel API — a Hono sub-app mounted at /agentos/api/*.
 *
 * Backs the private React dashboard at agentos.clawagent.sh. Read-only views of
 * agents, their persisted request logs, and past sessions (transcripts), plus a
 * thin "create a chat sandbox for this agent" endpoint so the web console drives
 * the SAME agent config as Slack (via sandboxBodyForBot) without exposing secrets
 * to the browser.
 *
 * All routes live under /agentos/api/* and stay behind the server's Basic Auth
 * (NOT whitelisted). In production Caddy gates agentos.clawagent.sh with its own
 * basic_auth and injects the Node API credential when proxying /api/* here.
 */
import { Hono } from "hono";
import { MongoClient, type Collection } from "mongodb";
import { randomUUID } from "node:crypto";
import { IdentitySource, type IdentitySource as IdentitySourceT } from "@open-gitagent/protocol";
import { sandboxBodyForBot } from "./slack-bot.ts";
import { AgentLogStore } from "./agent-log-store.ts";
import { ScheduleStore, computeNextRun, describeSchedule, type ScheduleKind } from "./schedule-store.ts";
import { runAgentOnce } from "./scheduler.ts";

/**
 * Normalize a stored `source` field (string | IdentitySource | undefined) into a
 * `{source, sourceUrl}` pair for the dashboard:
 *
 *   - structured IdentitySource → return as-is + extract the canonical URL/path.
 *   - bare string → keep as the legacy string form (in-memory agents still
 *     pass plain `source: "github.com/..."`); URL is derived heuristically.
 *
 * The dashboard treats `sourceUrl` as the agent's canonical identity (the
 * thing that's clickable + the de-duplication key across multiple workers
 * that registered the same git source).
 */
function normalizeSource(raw: unknown): { source: IdentitySourceT | string; sourceUrl: string | null } {
  if (raw && typeof raw === "object") {
    const parsed = IdentitySource.safeParse(raw);
    if (parsed.success) {
      const s = parsed.data;
      if (s.type === "git") return { source: s, sourceUrl: s.url };
      if (s.type === "local") return { source: s, sourceUrl: s.path };
      return { source: s, sourceUrl: "inline" };
    }
  }
  const str = typeof raw === "string" ? raw : "";
  return { source: str, sourceUrl: str || null };
}

/** An agent the control panel can list, chat with, and inspect. Covers both
 * Slack bots and web-only agents. */
export interface AgentDef {
  name: string;        // stable id, e.g. "gitagent" | "claude-code" | "deep-agent"
  label: string;       // display name, e.g. "GitAgent"
  harness: string;     // "gitagent" | "claude-agent-sdk" | "deepagents"
  source: string;
  model?: string;
  envs?: Record<string, string>;
  gitToken?: string;
}

// deepagents has no warm-sandbox support on this server, so it runs one-shot
// via POST /run instead of the multi-turn /sandboxes path.
const sandboxCapable = (harness: string) => harness !== "deepagents";

export interface AgentOSOptions {
  /** Loopback base URL of the ComputerAgent server. Default http://127.0.0.1:9100. */
  readonly caBase?: string;
  readonly mongoUrl: string;
  readonly mongoDb: string;
  readonly agents: readonly AgentDef[];
  readonly logStore: AgentLogStore;
  readonly scheduleStore?: ScheduleStore;
}

interface SessionDoc {
  _id: string;
  projectKey?: string;
  entries?: Array<{ type?: string; text?: string; uuid?: string }>;
  updatedAt?: Date;
}
interface ThreadDoc {
  _id: string;
  bot: string;
  channel: string;
  threadTs: string;
  sessionId: string;
  sandboxId: string | null;
  snapshotId: string | null;
  createdAt?: Date;
  lastMessageAt?: Date;
}

function caAuthHeader(): Record<string, string> {
  const u = process.env.API_AUTH_USER;
  const p = process.env.API_AUTH_PASS;
  if (!u || !p) return {};
  return { authorization: "Basic " + Buffer.from(`${u}:${p}`).toString("base64") };
}

export function createAgentOSApp(opts: AgentOSOptions): Hono {
  const caBase = (opts.caBase ?? "http://127.0.0.1:9100").replace(/\/+$/, "");
  const client = new MongoClient(opts.mongoUrl);
  let connected = false;
  let connectPromise: Promise<void> | null = null;
  const db = async () => {
    if (!connected) {
      if (!connectPromise) connectPromise = client.connect().then(() => { connected = true; });
      await connectPromise;
    }
    return client.db(opts.mongoDb);
  };
  const threadsColl = async (): Promise<Collection<ThreadDoc>> =>
    (await db()).collection<ThreadDoc>("slack_threads");
  const sessionsColl = async (): Promise<Collection<SessionDoc>> =>
    (await db()).collection<SessionDoc>("sessions");
  /**
   * agent_registry — agents registered dynamically by SDK consumers via the
   * `@open-gitagent/agent-registry-mongo` telemetry hook (or directly via the
   * POST /agentos/api/agents/register endpoint below). The dashboard unions
   * these with the server's hardcoded `opts.agents` (in-memory) — the
   * in-memory list takes precedence on name collision so the
   * harness/source/token wiring stays authoritative for agents this server
   * itself runs (Slack bots, framework-translator, etc).
   *
   * This is what makes library-mode deployments visible: a customer's
   * Temporal worker pod runs `new ComputerAgent({telemetry: new MongoTelemetry(...)})`
   * and the dashboard shows the agent immediately.
   */
  interface RegistryDoc {
    _id: string;
    label?: string;
    harness?: string;
    source?: unknown;
    model?: string;
    registeredBy?: string;
    registeredAt?: Date;
    updatedAt?: Date;
    lastSeen?: Date;
  }
  const registryColl = async (): Promise<Collection<RegistryDoc>> =>
    (await db()).collection<RegistryDoc>("agent_registry");

  /**
   * chat_pins — server-side mapping of agent → current dashboard chat session.
   *
   * Lets the SPA reuse the same sessionId across browser refreshes / sandbox
   * restarts without holding any state in the browser. Same pattern Slack
   * uses for thread → sessionId, but keyed on agent name for the dashboard's
   * single "current chat" semantics.
   *
   * The actual conversation memory lives in the harness server's
   * sessionStore (Mongo) keyed by sessionId; this collection is just the
   * pointer to "which sessionId is the agent's current dashboard chat."
   */
  interface ChatPinDoc {
    _id: string;       // agent name
    sessionId: string;
    updatedAt: Date;
  }
  const chatPinsColl = async (): Promise<Collection<ChatPinDoc>> =>
    (await db()).collection<ChatPinDoc>("chat_pins");

  const byName = new Map<string, AgentDef>(opts.agents.map((a) => [a.name, a]));
  const app = new Hono();

  // ── Agents list + per-agent stats ──────────────────────────────────────
  app.get("/agentos/api/agents", async (c) => {
    // Live sandboxes (loopback) — used to mark which agents have warm sessions.
    let liveBySession = new Map<string, string>(); // sessionId -> state
    try {
      const r = await fetch(`${caBase}/sandboxes`, { headers: caAuthHeader() });
      if (r.ok) {
        const j = await r.json() as { sandboxes?: Array<{ sessionId: string; state: string }> };
        liveBySession = new Map((j.sandboxes ?? []).map((s) => [s.sessionId, s.state]));
      }
    } catch { /* best-effort */ }

    const threads = await threadsColl();

    // Pull dynamically-registered agents from agent_registry. Best-effort:
    // if the collection doesn't exist yet (fresh deployment), or Mongo is
    // briefly unavailable, fall back to just the in-memory list.
    let registryRows: RegistryDoc[] = [];
    try {
      registryRows = await (await registryColl())
        .find({})
        .sort({ lastSeen: -1, updatedAt: -1 })
        .toArray();
    } catch {
      /* fall through with empty list */
    }

    // Union by name. In-memory wins on collision so server-hosted agents
    // (Slack bots, framework-translator, etc) retain their authoritative
    // harness/source/token wiring even if a worker registered the same name.
    const seen = new Set<string>(opts.agents.map((a) => a.name));
    const combined: Array<{
      name: string;
      label: string;
      harness: string;
      source: unknown;
      model: string | null;
      origin: "in-memory" | "registry";
      registeredBy?: string;
      lastSeen?: Date;
    }> = [];
    for (const a of opts.agents) {
      combined.push({
        name: a.name,
        label: a.label,
        harness: a.harness,
        source: a.source,
        model: a.model ?? null,
        origin: "in-memory",
      });
    }
    for (const r of registryRows) {
      if (seen.has(r._id)) continue;
      combined.push({
        name: r._id,
        label: r.label ?? r._id,
        harness: r.harness ?? "unknown",
        source: r.source ?? "",
        model: r.model ?? null,
        origin: "registry",
        registeredBy: r.registeredBy,
        lastSeen: r.lastSeen,
      });
    }

    const out = [];
    for (const a of combined) {
      const docs = await threads.find({ bot: a.name }).toArray();
      const sessionIds = new Set(docs.map((d) => d.sessionId));
      let active = 0;
      for (const sid of sessionIds) {
        const st = liveBySession.get(sid);
        if (st && st !== "expired" && st !== "disposed") active++;
      }
      const lastActivity = docs.reduce<Date | null>((acc, d) => {
        const t = d.lastMessageAt ? new Date(d.lastMessageAt) : null;
        return t && (!acc || t > acc) ? t : acc;
      }, null);
      // Normalize source — structured IdentitySource (from agent_registry
      // upserts via MongoTelemetry) becomes a {source, sourceUrl} pair the
      // dashboard renders as a clickable owner/repo identity for git sources.
      const { source, sourceUrl } = normalizeSource(a.source);
      out.push({
        name: a.name,
        label: a.label,
        harness: a.harness,
        source,
        sourceUrl,
        model: a.model,
        origin: a.origin,
        registeredBy: a.registeredBy ?? null,
        lastSeen: a.lastSeen ? a.lastSeen.toISOString() : null,
        sandboxCapable: sandboxCapable(a.harness),
        sessionCount: sessionIds.size,
        activeSandboxes: active,
        lastActivity: lastActivity ? lastActivity.toISOString() : null,
        logCount: await opts.logStore.count(a.name),
      });
    }
    return c.json({ agents: out });
  });

  // Lookup by source URL — used to detect "same agent, different name"
  // (e.g. dev + prod workers both registering the same git repo as separate
  // names). The dashboard groups these visually.
  app.get("/agentos/api/agents/by-source", async (c) => {
    const url = c.req.query("url");
    if (!url) return c.json({ error: { code: "BAD_REQUEST", message: "`url` required" } }, 400);
    const matches: Array<{ name: string; source: IdentitySourceT | string; sourceUrl: string | null }> = [];
    for (const a of opts.agents) {
      const norm = normalizeSource(a.source);
      if (norm.sourceUrl === url) matches.push({ name: a.name, source: norm.source, sourceUrl: norm.sourceUrl });
    }
    try {
      const rows = await (await registryColl()).find({}).toArray();
      for (const r of rows) {
        const norm = normalizeSource(r.source);
        if (norm.sourceUrl === url) {
          matches.push({ name: r._id, source: norm.source, sourceUrl: norm.sourceUrl });
        }
      }
    } catch {
      /* registry collection optional */
    }
    return c.json({ url, matches });
  });

  // ── Agent registry CRUD ─────────────────────────────────────────────────
  // Registry-side mutations only — the in-memory list configured at server
  // startup is never modified by these endpoints. Library-mode SDK consumers
  // can also write directly via `MongoTelemetry`; this endpoint is for ops
  // tools / manual registration from the dashboard.

  app.post("/agentos/api/agents/register", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) return c.json({ error: { code: "BAD_REQUEST", message: "`name` required" } }, 400);
    const now = new Date();
    const set: Partial<RegistryDoc> = {
      label: typeof body.label === "string" ? body.label : undefined,
      harness: typeof body.harness === "string" ? body.harness : undefined,
      source: body.source ?? undefined,
      model: typeof body.model === "string" ? body.model : undefined,
      registeredBy: typeof body.registeredBy === "string" ? body.registeredBy : undefined,
      updatedAt: now,
      lastSeen: now,
    };
    for (const k of Object.keys(set) as (keyof typeof set)[]) {
      if (set[k] === undefined) delete set[k];
    }
    await (
      await registryColl()
    ).updateOne(
      { _id: name },
      { $set: set, $setOnInsert: { _id: name, registeredAt: now } },
      { upsert: true },
    );
    return c.json({ ok: true, name });
  });

  app.patch("/agentos/api/agents/:name", async (c) => {
    const name = c.req.param("name");
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    if (byName.has(name)) {
      return c.json(
        {
          error: {
            code: "IN_MEMORY_AGENT",
            message: "This agent is configured at server startup; edit examples/computeragent-server.ts instead.",
          },
        },
        409,
      );
    }
    const set: Partial<RegistryDoc> = {
      label: typeof body.label === "string" ? body.label : undefined,
      harness: typeof body.harness === "string" ? body.harness : undefined,
      source: body.source,
      model: typeof body.model === "string" ? body.model : undefined,
      updatedAt: new Date(),
    };
    for (const k of Object.keys(set) as (keyof typeof set)[]) {
      if (set[k] === undefined) delete set[k];
    }
    const r = await (await registryColl()).updateOne({ _id: name }, { $set: set });
    if (r.matchedCount === 0) return c.json({ error: { code: "NOT_FOUND" } }, 404);
    return c.json({ ok: true });
  });

  app.delete("/agentos/api/agents/:name", async (c) => {
    const name = c.req.param("name");
    if (byName.has(name)) {
      return c.json(
        {
          error: {
            code: "IN_MEMORY_AGENT",
            message: "This agent is configured at server startup; remove it from examples/computeragent-server.ts and restart.",
          },
        },
        409,
      );
    }
    const r = await (await registryColl()).deleteOne({ _id: name });
    if (r.deletedCount === 0) return c.json({ error: { code: "NOT_FOUND" } }, 404);
    return c.json({ ok: true });
  });

  // ── Request logs ────────────────────────────────────────────────────────
  app.get("/agentos/api/logs", async (c) => {
    const bot = c.req.query("bot") || undefined;
    const limit = Number(c.req.query("limit") ?? "50");
    const beforeRaw = c.req.query("before");
    const before = beforeRaw ? new Date(beforeRaw) : undefined;
    const logs = await opts.logStore.list({ bot, limit, before });
    return c.json({ logs });
  });

  // Append a web-console chat to the log (called by the SPA after a turn).
  app.post("/agentos/api/logs", async (c) => {
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    await opts.logStore.append({
      source: "web",
      bot: String(body.bot ?? "unknown"),
      requester: String(body.requester ?? "web"),
      channel: null,
      threadTs: null,
      sessionId: body.sessionId ? String(body.sessionId) : null,
      query: String(body.query ?? ""),
      reply: String(body.reply ?? ""),
      ok: body.ok !== false,
    });
    return c.json({ ok: true });
  });

  // ── Sessions list + transcript ──────────────────────────────────────────
  app.get("/agentos/api/sessions", async (c) => {
    const bot = c.req.query("bot") || undefined;
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? "50"), 1), 200);
    const threads = await threadsColl();
    const q = bot ? { bot } : {};
    const docs = await threads.find(q).sort({ lastMessageAt: -1 }).limit(limit).toArray();
    return c.json({
      sessions: docs.map((d) => ({
        sessionId: d.sessionId,
        bot: d.bot,
        channel: d.channel,
        threadTs: d.threadTs,
        sandboxId: d.sandboxId ?? null,
        snapshotId: d.snapshotId ?? null,
        createdAt: d.createdAt ? new Date(d.createdAt).toISOString() : null,
        lastMessageAt: d.lastMessageAt ? new Date(d.lastMessageAt).toISOString() : null,
      })),
    });
  });

  app.get("/agentos/api/sessions/:id", async (c) => {
    const id = c.req.param("id");
    const [sessions, threads] = [await sessionsColl(), await threadsColl()];
    // Two storage shapes:
    //   - gitagent / engine-agnostic: sessions._id == sessionId
    //   - claude-agent-sdk: sessions._id is a UUID, sessionId is embedded in
    //     projectKey (a flattened version of the workdir path), e.g.
    //     "-tmp-computeragent-sessions-agentos-architect-<uuid>"
    // Try both so transcripts work uniformly across harnesses.
    const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const session =
      (await sessions.findOne({ _id: id })) ??
      (await sessions.findOne({ projectKey: { $regex: `${escapedId}$` } }));
    const thread = await threads.findOne({ sessionId: id });
    return c.json({
      sessionId: id,
      thread: thread
        ? {
            bot: thread.bot, channel: thread.channel, threadTs: thread.threadTs,
            sandboxId: thread.sandboxId ?? null, snapshotId: thread.snapshotId ?? null,
            lastMessageAt: thread.lastMessageAt ? new Date(thread.lastMessageAt).toISOString() : null,
          }
        : null,
      updatedAt: session?.updatedAt ? new Date(session.updatedAt).toISOString() : null,
      // Multiple session-storage shapes, depending on the harness:
      //   gitagent           → {type:"user"|"assistant", text}
      //   claude-agent-sdk   → {type:"user", message:{role,content}} where
      //                        content is either a string or [{type:"text",text}]
      //                        plus meta events (queue-operation) with no text
      // We normalize to {type:"user"|"assistant", text} for the SPA.
      entries: (session?.entries ?? [])
        .map((raw) => {
          const e = raw as Record<string, unknown>;
          if (e.type === "queue-operation") return { type: "meta", text: "" };
          const message = (e.message ?? null) as { role?: string; content?: unknown } | null;
          const role = (message?.role as string | undefined) ?? (e.type as string | undefined) ?? "assistant";
          const content: unknown = message?.content ?? e.content ?? e.text;
          let text = "";
          if (typeof content === "string") text = content;
          else if (Array.isArray(content)) {
            text = content
              .filter((b): b is { type: string; text: string } =>
                !!b && typeof b === "object" && (b as { type?: string }).type === "text")
              .map((b) => b.text)
              .join("\n");
          }
          const role2 = role === "user" || role === "assistant" ? role : "assistant";
          return { type: role2, text: text.trim() };
        })
        .filter((e) => e.text.length > 0),
    });
  });

  // ── Create a chat sandbox for an agent (web console) ─────────────────────
  // Builds the SAME sandbox config the Slack flow uses (Lyzr model, envs,
  // gitToken) server-side. Pass an existing sessionId to resume that thread's
  // conversation memory; otherwise a fresh console session is minted.
  // Look up an agent by name — in-memory first, then the Mongo registry.
  // Registry agents have no auth/envs persisted; the server's own env (forwarded
  // via inheritEssentialHostEnv) provides ANTHROPIC_API_KEY etc.
  async function resolveAgent(name: string): Promise<AgentDef | undefined> {
    const inMem = byName.get(name);
    if (inMem) return inMem;
    try {
      const doc = await (await registryColl()).findOne({ _id: name });
      if (!doc) return undefined;
      const srcStr = typeof doc.source === "string"
        ? doc.source
        : (doc.source as { url?: string; path?: string })?.url ?? (doc.source as { path?: string })?.path ?? "";
      return {
        name: doc._id,
        label: doc.label ?? doc._id,
        harness: doc.harness ?? "claude-agent-sdk",
        source: srcStr,
        model: doc.model,
      };
    } catch {
      return undefined;
    }
  }

  app.post("/agentos/api/agents/:name/chat-sandbox", async (c) => {
    const agent = await resolveAgent(c.req.param("name"));
    if (!agent) return c.json({ error: { code: "UNKNOWN_AGENT" } }, 404);
    if (!sandboxCapable(agent.harness)) {
      return c.json({ error: { code: "NO_SANDBOX", message: `${agent.label} runs one-shot — use /run` } }, 400);
    }
    const body = await c.req.json().catch(() => ({})) as { sessionId?: string };

    // Resume order: explicit body.sessionId > server-pinned > new
    let sessionId = body.sessionId;
    if (!sessionId) {
      try {
        const pin = await (await chatPinsColl()).findOne({ _id: agent.name });
        if (pin?.sessionId) sessionId = pin.sessionId;
      } catch { /* fall through to fresh */ }
    }
    if (!sessionId) sessionId = `agentos-${agent.name}-${randomUUID().slice(0, 12)}`;

    const sandboxBody = sandboxBodyForBot(
      { name: agent.name, harness: agent.harness, source: agent.source, model: agent.model, extraEnvs: agent.envs, gitToken: agent.gitToken },
      sessionId,
    );
    const r = await fetch(`${caBase}/sandboxes`, {
      method: "POST",
      headers: { "content-type": "application/json", ...caAuthHeader() },
      body: JSON.stringify(sandboxBody),
    });
    if (!r.ok) {
      const text = await r.text();
      return c.json({ error: { code: "SANDBOX_CREATE_FAILED", detail: text.slice(0, 300) } }, 502);
    }
    const j = await r.json() as { sandboxId: string };

    // Pin this sessionId as the agent's current dashboard chat so the next
    // boot from any browser resumes the same conversation.
    try {
      await (await chatPinsColl()).updateOne(
        { _id: agent.name },
        { $set: { sessionId, updatedAt: new Date() } },
        { upsert: true },
      );
    } catch { /* best effort */ }

    // Also write a slack_threads-style row so the /sessions + /agents
    // endpoints (which join by `bot`) can see web chats. We reuse this
    // collection rather than introduce a separate "web_threads" so the
    // dashboard's session list is uniformly populated. Slack threads use a
    // real channel+threadTs; web threads use channel="web" + the sessionId
    // as the synthetic threadTs.
    try {
      const now = new Date();
      await threadsColl().then((threads) => threads.updateOne(
        { _id: `web:${sessionId}` },
        {
          $set: {
            bot: agent.name,
            channel: "web",
            threadTs: sessionId,
            sessionId,
            sandboxId: j.sandboxId,
            snapshotId: null,
            lastMessageAt: now,
          },
          $setOnInsert: { createdAt: now },
        },
        { upsert: true },
      ));
    } catch { /* best effort — dashboard will fall back to empty session list */ }

    return c.json({ sandboxId: j.sandboxId, sessionId, bot: agent.name });
  });

  // DELETE the agent's chat pin — "New chat" button.
  app.delete("/agentos/api/agents/:name/chat-pin", async (c) => {
    try { await (await chatPinsColl()).deleteOne({ _id: c.req.param("name") }); } catch { /* ignore */ }
    return c.json({ ok: true });
  });

  // ── One-shot run (for deepagents, which has no warm-sandbox support) ─────
  // Streams a fresh POST /run back to the browser. No conversation memory
  // across turns — each message is an independent run.
  app.post("/agentos/api/agents/:name/run", async (c) => {
    const agent = await resolveAgent(c.req.param("name"));
    if (!agent) return c.json({ error: { code: "UNKNOWN_AGENT" } }, 404);
    const body = await c.req.json().catch(() => ({})) as { message?: string };
    const runBody: Record<string, unknown> = {
      source: agent.source,
      harness: agent.harness,
      runtime: "bwrap",
      options: { permissionMode: "bypassPermissions", settingSources: ["project"] },
      envs: agent.envs ?? {},
      message: body.message ?? "",
    };
    if (agent.model) runBody.model = agent.model;
    if (agent.gitToken) runBody.gitToken = agent.gitToken;
    const upstream = await fetch(`${caBase}/run`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream", ...caAuthHeader() },
      body: JSON.stringify(runBody),
    });
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        "content-type": upstream.headers.get("content-type") ?? "text/event-stream",
        "cache-control": "no-cache",
      },
    });
  });

  // ── SSE chat proxy ───────────────────────────────────────────────────────
  // Streams a turn from the loopback /sandboxes/:id/chat back to the browser so
  // the SPA only ever talks to /agentos/api/* (one Caddy proxy path, no need to
  // expose the raw /sandboxes surface on the agentos subdomain).
  app.post("/agentos/api/sandboxes/:id/chat", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.text();
    const upstream = await fetch(`${caBase}/sandboxes/${encodeURIComponent(id)}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream", ...caAuthHeader() },
      body,
    });
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        "content-type": upstream.headers.get("content-type") ?? "text/event-stream",
        "cache-control": "no-cache",
      },
    });
  });

  // Artifact passthrough — lets the SPA download files the agent produced.
  app.get("/agentos/api/sandboxes/:id/artifact", async (c) => {
    const id = c.req.param("id");
    const path = c.req.query("path") ?? "";
    const upstream = await fetch(
      `${caBase}/sandboxes/${encodeURIComponent(id)}/artifact?path=${encodeURIComponent(path)}`,
      { headers: caAuthHeader() },
    );
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { "content-type": upstream.headers.get("content-type") ?? "application/octet-stream" },
    });
  });

  // ── Schedules ────────────────────────────────────────────────────────────
  const sched = opts.scheduleStore;
  const withDesc = (s: any) => ({ ...s, description: describeSchedule(s) });

  app.get("/agentos/api/schedules", async (c) => {
    if (!sched) return c.json({ schedules: [] });
    const agent = c.req.query("agent") || undefined;
    const list = await sched.list(agent);
    return c.json({ schedules: list.map(withDesc) });
  });

  app.post("/agentos/api/schedules", async (c) => {
    if (!sched) return c.json({ error: { code: "NO_SCHEDULER" } }, 503);
    const b = await c.req.json().catch(() => ({})) as Record<string, any>;
    if (!b.agentName || !byName.has(String(b.agentName))) return c.json({ error: { code: "UNKNOWN_AGENT" } }, 400);
    if (!b.prompt || !String(b.prompt).trim()) return c.json({ error: { code: "MISSING_PROMPT" } }, 400);
    const kind: ScheduleKind = b.kind === "daily" ? "daily" : "interval";
    const created = await sched.create({
      agentName: String(b.agentName),
      prompt: String(b.prompt),
      kind,
      intervalMinutes: kind === "interval" ? Math.max(1, Number(b.intervalMinutes) || 60) : undefined,
      hourUtc: kind === "daily" ? Math.min(23, Math.max(0, Number(b.hourUtc) || 0)) : undefined,
      minuteUtc: kind === "daily" ? Math.min(59, Math.max(0, Number(b.minuteUtc) || 0)) : undefined,
      enabled: b.enabled !== false,
    });
    return c.json({ schedule: withDesc(created) });
  });

  app.patch("/agentos/api/schedules/:id", async (c) => {
    if (!sched) return c.json({ error: { code: "NO_SCHEDULER" } }, 503);
    const id = c.req.param("id");
    const existing = await sched.get(id);
    if (!existing) return c.json({ error: { code: "NOT_FOUND" } }, 404);
    const b = await c.req.json().catch(() => ({})) as Record<string, any>;
    const fields: Record<string, unknown> = {};
    if (typeof b.enabled === "boolean") fields.enabled = b.enabled;
    if (b.prompt !== undefined) fields.prompt = String(b.prompt);
    // If cadence changed, recompute nextRunAt.
    const spec = { kind: existing.kind, intervalMinutes: existing.intervalMinutes, hourUtc: existing.hourUtc, minuteUtc: existing.minuteUtc, ...b };
    if (b.kind || b.intervalMinutes !== undefined || b.hourUtc !== undefined || b.minuteUtc !== undefined) {
      Object.assign(fields, {
        kind: spec.kind, intervalMinutes: spec.intervalMinutes, hourUtc: spec.hourUtc, minuteUtc: spec.minuteUtc,
        nextRunAt: computeNextRun(spec as any),
      });
    }
    await sched.update(id, fields);
    const updated = await sched.get(id);
    return c.json({ schedule: updated ? withDesc(updated) : null });
  });

  app.delete("/agentos/api/schedules/:id", async (c) => {
    if (!sched) return c.json({ error: { code: "NO_SCHEDULER" } }, 503);
    await sched.delete(c.req.param("id"));
    return c.json({ ok: true });
  });

  // Manual trigger — runs now (best-effort, detached) and records the result.
  app.post("/agentos/api/schedules/:id/run-now", async (c) => {
    if (!sched) return c.json({ error: { code: "NO_SCHEDULER" } }, 503);
    const s = await sched.get(c.req.param("id"));
    if (!s) return c.json({ error: { code: "NOT_FOUND" } }, 404);
    const agent = byName.get(s.agentName);
    if (!agent) return c.json({ error: { code: "UNKNOWN_AGENT" } }, 400);
    await sched.update(s._id, { lastRunAt: new Date(), lastStatus: "running" });
    void (async () => {
      const res = await runAgentOnce(caBase, caAuthHeader(), agent, s.prompt).catch((e) => ({ ok: false, text: String(e) }));
      await sched.update(s._id, { lastStatus: res.ok ? "ok" : "error", lastResult: res.text.slice(0, 2000) });
      await opts.logStore.append({
        source: "schedule", bot: s.agentName, requester: "manual-run",
        channel: null, threadTs: null, sessionId: s._id, query: s.prompt, reply: res.text, ok: res.ok,
      }).catch(() => {});
    })();
    return c.json({ ok: true, running: true });
  });

  app.get("/agentos/api/health", (c) => c.json({ ok: true, agents: opts.agents.map((a) => a.name) }));

  return app;
}
