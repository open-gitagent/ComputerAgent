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
import { sandboxBodyForBot } from "./slack-bot.ts";
import { AgentLogStore } from "./agent-log-store.ts";
import { ScheduleStore, computeNextRun, describeSchedule, type ScheduleKind } from "./schedule-store.ts";
import { runAgentOnce } from "./scheduler.ts";
import { AgentPolicyStore } from "./agent-policy-store.ts";

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
  readonly policyStore?: AgentPolicyStore;
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

  const byName = new Map<string, AgentDef>(opts.agents.map((a) => [a.name, a]));
  const app = new Hono();

  // SRS (policy backend) — hoisted so the chat-sandbox handler and the
  // policy-proxy routes share the same config.
  const srsBase = (process.env.SRS_BASE_URL ?? "https://srs-dev.test.studio.lyzr.ai").replace(/\/+$/, "");
  const srsKey = process.env.LYZR_API_KEY ?? process.env.SRS_API_KEY ?? "";
  const srsHeaders = (extra: Record<string, string> = {}): Record<string, string> => {
    const h: Record<string, string> = { ...extra };
    if (srsKey) h["x-api-key"] = srsKey;
    return h;
  };
  const srsProxy = async (method: string, path: string, body?: unknown): Promise<Response> => {
    if (!srsKey) {
      return new Response(JSON.stringify({ error: { code: "SRS_NOT_CONFIGURED", message: "LYZR_API_KEY not set" } }), { status: 503, headers: { "content-type": "application/json" } });
    }
    const init: RequestInit = {
      method,
      headers: srsHeaders(body !== undefined ? { "content-type": "application/json" } : {}),
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    const r = await fetch(`${srsBase}${path}`, init);
    const text = await r.text();
    return new Response(text, { status: r.status, headers: { "content-type": r.headers.get("content-type") ?? "application/json" } });
  };

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
    for (const a of opts.agents) {
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
      out.push({
        name: a.name,
        label: a.label,
        harness: a.harness,
        source: a.source,
        model: a.model ?? null,
        sandboxCapable: sandboxCapable(a.harness),
        sessionCount: sessionIds.size,
        activeSandboxes: active,
        lastActivity: lastActivity ? lastActivity.toISOString() : null,
        logCount: await opts.logStore.count(a.name),
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
    const agent = byName.get(c.req.param("name"));
    if (!agent) return c.json({ error: { code: "UNKNOWN_AGENT" } }, 404);
    if (!sandboxCapable(agent.harness)) {
      return c.json({ error: { code: "NO_SANDBOX", message: `${agent.label} runs one-shot — use /run` } }, 400);
    }
    const body = await c.req.json().catch(() => ({})) as { sessionId?: string };
    const sessionId = body.sessionId || `agentos-${agent.name}-${randomUUID().slice(0, 12)}`;
    // Lookup policy binding (if any) and translate to a sandbox policy spec.
    let policySpec: { kind: "srs"; endpoint: string; apiKey: string; policyId: string; principalId: string } | undefined;
    if (opts.policyStore && srsKey) {
      const binding = await opts.policyStore.get(agent.name);
      if (binding) {
        policySpec = {
          kind: "srs",
          endpoint: srsBase,
          apiKey: srsKey,
          policyId: binding.policyId,
          principalId: `agentos:${agent.name}`,
        };
      }
    }
    const sandboxBody = sandboxBodyForBot(
      { name: agent.name, harness: agent.harness, source: agent.source, model: agent.model, extraEnvs: agent.envs, gitToken: agent.gitToken },
      sessionId,
      policySpec,
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
    return c.json({ sandboxId: j.sandboxId, sessionId, bot: agent.name });
  });

  // ── One-shot run (for deepagents, which has no warm-sandbox support) ─────
  // Streams a fresh POST /run back to the browser. No conversation memory
  // across turns — each message is an independent run.
  app.post("/agentos/api/agents/:name/run", async (c) => {
    const agent = byName.get(c.req.param("name"));
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

  // ── Policies — proxy SRS so the browser never sees LYZR_API_KEY ─────────
  //
  // SRS (Lyzr Studio Responsible AI APIs) owns policy CRUD. We forward
  // GET/POST/PUT/DELETE on /v1/rai/policies, inject `x-api-key` server-side,
  // and pass the body through unchanged. The dropdown on the agent screen
  // uses GET /policies to populate; the policy editor uses POST/PUT.
  app.get("/agentos/api/policies", async () => srsProxy("GET", "/v1/rai/policies"));
  app.get("/agentos/api/policies/:id", async (c) => srsProxy("GET", `/v1/rai/policies/${encodeURIComponent(c.req.param("id"))}`));
  app.post("/agentos/api/policies", async (c) => srsProxy("POST", "/v1/rai/policies", await c.req.json().catch(() => ({}))));
  app.put("/agentos/api/policies/:id", async (c) => srsProxy("PUT", `/v1/rai/policies/${encodeURIComponent(c.req.param("id"))}`, await c.req.json().catch(() => ({}))));
  app.delete("/agentos/api/policies/:id", async (c) => srsProxy("DELETE", `/v1/rai/policies/${encodeURIComponent(c.req.param("id"))}`));

  // OPA rego policies — referenced by RAI policies' opa_guardrail.managed_policies[].policy_id.
  app.get("/agentos/api/opa-policies", async () => srsProxy("GET", "/v1/opa-policies"));
  app.get("/agentos/api/opa-policies/:id", async (c) => srsProxy("GET", `/v1/opa-policies/${encodeURIComponent(c.req.param("id"))}`));
  app.post("/agentos/api/opa-policies", async (c) => srsProxy("POST", "/v1/opa-policies", await c.req.json().catch(() => ({}))));
  app.put("/agentos/api/opa-policies/:id", async (c) => srsProxy("PUT", `/v1/opa-policies/${encodeURIComponent(c.req.param("id"))}`, await c.req.json().catch(() => ({}))));
  app.delete("/agentos/api/opa-policies/:id", async (c) => srsProxy("DELETE", `/v1/opa-policies/${encodeURIComponent(c.req.param("id"))}`));

  // ── Agent → policy binding (our own; lives in Mongo, not SRS) ───────────
  //
  // One policy_id per agent. The runtime reads this at sandbox-create time
  // and feeds it into the SrsPolicyDecider that gates every tool call.
  app.get("/agentos/api/agents/:name/policy", async (c) => {
    if (!opts.policyStore) return c.json({ error: { code: "NO_POLICY_STORE" } }, 503);
    if (!byName.has(c.req.param("name"))) return c.json({ error: { code: "UNKNOWN_AGENT" } }, 404);
    const b = await opts.policyStore.get(c.req.param("name"));
    return c.json({ binding: b });
  });
  app.put("/agentos/api/agents/:name/policy", async (c) => {
    if (!opts.policyStore) return c.json({ error: { code: "NO_POLICY_STORE" } }, 503);
    if (!byName.has(c.req.param("name"))) return c.json({ error: { code: "UNKNOWN_AGENT" } }, 404);
    const body = await c.req.json().catch(() => ({})) as { policy_id?: string | null };
    if (body.policy_id == null) {
      await opts.policyStore.delete(c.req.param("name"));
      return c.json({ binding: null });
    }
    const b = await opts.policyStore.set(c.req.param("name"), body.policy_id);
    return c.json({ binding: b });
  });
  app.delete("/agentos/api/agents/:name/policy", async (c) => {
    if (!opts.policyStore) return c.json({ error: { code: "NO_POLICY_STORE" } }, 503);
    await opts.policyStore.delete(c.req.param("name"));
    return c.json({ ok: true });
  });

  app.get("/agentos/api/health", (c) => c.json({ ok: true, agents: opts.agents.map((a) => a.name) }));

  return app;
}
