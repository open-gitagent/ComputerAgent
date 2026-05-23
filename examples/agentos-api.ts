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
import { type BotConfig, sandboxBodyForBot } from "./slack-bot.ts";
import { AgentLogStore } from "./agent-log-store.ts";

export interface AgentOSOptions {
  /** Loopback base URL of the ComputerAgent server. Default http://127.0.0.1:9100. */
  readonly caBase?: string;
  readonly mongoUrl: string;
  readonly mongoDb: string;
  readonly bots: readonly BotConfig[];
  readonly logStore: AgentLogStore;
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

  const byName = new Map<string, BotConfig>(opts.bots.map((b) => [b.name, b]));
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
    const out = [];
    for (const b of opts.bots) {
      const docs = await threads.find({ bot: b.name }).toArray();
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
      out.push({
        name: b.name,
        harness: b.harness,
        source: b.source,
        model: b.model ?? null,
        sessionCount: sessionIds.size,
        activeSandboxes: active,
        lastActivity: lastActivity ? lastActivity.toISOString() : null,
        logCount: await opts.logStore.count(b.name),
      });
    }
    return c.json({ agents: out });
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
    const session = await sessions.findOne({ _id: id });
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
      entries: (session?.entries ?? []).map((e) => ({ type: e.type ?? "assistant", text: e.text ?? "" })),
    });
  });

  // ── Create a chat sandbox for an agent (web console) ─────────────────────
  // Builds the SAME sandbox config the Slack flow uses (Lyzr model, envs,
  // gitToken) server-side. Pass an existing sessionId to resume that thread's
  // conversation memory; otherwise a fresh console session is minted.
  app.post("/agentos/api/agents/:name/chat-sandbox", async (c) => {
    const bot = byName.get(c.req.param("name"));
    if (!bot) return c.json({ error: { code: "UNKNOWN_AGENT" } }, 404);
    const body = await c.req.json().catch(() => ({})) as { sessionId?: string };
    const sessionId = body.sessionId || `agentos-${bot.name}-${randomUUID().slice(0, 12)}`;
    const sandboxBody = sandboxBodyForBot(bot, sessionId);
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
    return c.json({ sandboxId: j.sandboxId, sessionId, bot: bot.name });
  });

  app.get("/agentos/api/health", (c) => c.json({ ok: true, agents: opts.bots.map((b) => b.name) }));

  return app;
}
