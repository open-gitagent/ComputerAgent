// Agent registry surface — registry-only, no in-memory list.
//
//   GET    /agentos/api/agents              — list + per-agent stats
//   GET    /agentos/api/agents/by-source    — dedupe by source URL
//   POST   /agentos/api/agents/register     — upsert
//   PATCH  /agentos/api/agents/:name
//   DELETE /agentos/api/agents/:name
//
// `register` is the dynamic-agents hook: a user submits
//   { name, label, source, model? } → server forces harness=claude-agent-sdk
//   if not specified, persists to Mongo, and the agent is immediately
//   chattable / scheduleable. Secrets stay in process.env.

import { Router, type Router as IRouter } from "express";
import { registryColl, threadsColl, type RegistryDoc } from "../mongo.js";
import { caBase } from "../upstream.js";
import { caAuthHeader } from "../auth.js";
import { agentLogStore } from "../stores/agent-log-store.js";
import { normalizeSource, registryDocToAgentDef, sandboxCapable } from "../agent-defs.js";

export const agentsRouter: IRouter = Router();

agentsRouter.get("/agents", async (_req, res, next) => {
  try {
    // Live sandboxes — used to flag agents with warm sessions. Best-effort
    // with a 2s timeout so a slow / unreachable harness never blocks the
    // dashboard's agent list (the list itself comes from Mongo).
    let liveBySession = new Map<string, string>();
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 2_000);
      const r = await fetch(`${caBase()}/sandboxes`, {
        headers: caAuthHeader(),
        signal: ctl.signal,
      }).finally(() => clearTimeout(timer));
      if (r.ok) {
        const j = (await r.json()) as { sandboxes?: Array<{ sessionId: string; state: string }> };
        liveBySession = new Map((j.sandboxes ?? []).map((s) => [s.sessionId, s.state]));
      }
    } catch { /* best-effort — empty map means "no live info available" */ }

    const threads = await threadsColl();
    const rows = await (await registryColl())
      .find({})
      .sort({ lastSeen: -1, updatedAt: -1 })
      .toArray();

    const out = [];
    for (const r of rows) {
      const agent = registryDocToAgentDef(r);
      const docs = await threads.find({ bot: agent.name }).toArray();
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
      const { source, sourceUrl } = normalizeSource(r.source);
      out.push({
        name: agent.name,
        label: agent.label,
        harness: agent.harness,
        source,
        sourceUrl,
        model: agent.model ?? null,
        origin: "registry" as const,
        registeredBy: r.registeredBy ?? null,
        lastSeen: r.lastSeen ? r.lastSeen.toISOString() : null,
        sandboxCapable: sandboxCapable(agent.harness),
        sessionCount: sessionIds.size,
        activeSandboxes: active,
        lastActivity: lastActivity ? lastActivity.toISOString() : null,
        logCount: await agentLogStore.count(agent.name),
      });
    }
    res.json({ agents: out });
  } catch (err) { next(err); }
});

agentsRouter.get("/agents/by-source", async (req, res, next) => {
  try {
    const url = typeof req.query["url"] === "string" ? req.query["url"] : "";
    if (!url) return res.status(400).json({ error: { code: "BAD_REQUEST", message: "`url` required" } });
    const rows = await (await registryColl()).find({}).toArray();
    const matches = rows
      .map((r) => ({ name: r._id, ...normalizeSource(r.source) }))
      .filter((m) => m.sourceUrl === url);
    res.json({ url, matches });
  } catch (err) { next(err); }
});

agentsRouter.post("/agents/register", async (req, res, next) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = typeof body["name"] === "string" ? body["name"].trim() : "";
    if (!name) {
      return res.status(400).json({ error: { code: "BAD_REQUEST", message: "`name` required" } });
    }
    const now = new Date();
    // Default harness to claude-agent-sdk so the dashboard's add-agent form
    // can post just { name, source } and get a working agent. Other harnesses
    // can still be passed explicitly. Other fields (label, source, model)
    // are pre-filled by the frontend form — keep the server's job thin.
    const harness = typeof body["harness"] === "string" ? body["harness"] : "claude-agent-sdk";
    const set: Partial<RegistryDoc> = {
      harness,
      updatedAt: now,
      lastSeen: now,
    };
    if (typeof body["label"] === "string") set.label = body["label"];
    if (body["source"] !== undefined) set.source = body["source"];
    if (typeof body["model"] === "string") set.model = body["model"];
    if (typeof body["registeredBy"] === "string") set.registeredBy = body["registeredBy"];
    await (await registryColl()).updateOne(
      { _id: name },
      { $set: set, $setOnInsert: { _id: name, registeredAt: now } },
      { upsert: true },
    );
    res.json({ ok: true, name });
  } catch (err) { next(err); }
});

agentsRouter.patch("/agents/:name", async (req, res, next) => {
  try {
    const name = req.params["name"]!;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const set: Partial<RegistryDoc> = { updatedAt: new Date() };
    if (typeof body["label"] === "string") set.label = body["label"];
    if (typeof body["harness"] === "string") set.harness = body["harness"];
    if (body["source"] !== undefined) set.source = body["source"];
    if (typeof body["model"] === "string") set.model = body["model"];
    const r = await (await registryColl()).updateOne({ _id: name }, { $set: set });
    if (r.matchedCount === 0) return res.status(404).json({ error: { code: "NOT_FOUND" } });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

agentsRouter.delete("/agents/:name", async (req, res, next) => {
  try {
    const name = req.params["name"]!;
    const r = await (await registryColl()).deleteOne({ _id: name });
    if (r.deletedCount === 0) return res.status(404).json({ error: { code: "NOT_FOUND" } });
    res.json({ ok: true });
  } catch (err) { next(err); }
});
