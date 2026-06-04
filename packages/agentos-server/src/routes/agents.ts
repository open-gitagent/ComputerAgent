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
import { chatPinsColl, chatSessionsColl, messagesColl, registryColl, sessionsColl, type RegistryDoc } from "../mongo.js";
import { listLiveSandboxes } from "../upstream.js";
import { agentLogStore } from "../stores/agent-log-store.js";
import { scheduleStore } from "../stores/schedule-store.js";
import { deleteAgentSnapshots, disposeLiveSandboxes } from "../cleanup.js";
import { hasResolvableSource, normalizeSource, registryDocToAgentDef, sandboxCapable } from "../agent-defs.js";

export const agentsRouter: IRouter = Router();

agentsRouter.get("/agents", async (_req, res, next) => {
  try {
    // Live sandboxes — used to flag agents with warm sessions. Best-effort:
    // an unreachable harness yields an empty map ("no live info available").
    const liveBySession = new Map(
      (await listLiveSandboxes()).map((s) => [s.sessionId, s.state]),
    );

    const chatSessions = await chatSessionsColl();
    const rows = await (await registryColl())
      .find({})
      .sort({ lastSeen: -1, updatedAt: -1 })
      .toArray();

    const out = [];
    for (const r of rows) {
      const agent = registryDocToAgentDef(r);
      const docs = await chatSessions.find({ agent: agent.name }).toArray();
      const sessionIds = new Set(docs.map((d) => d._id));
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
      const sCap = sandboxCapable(agent.harness);
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
        sandboxCapable: sCap,
        // True when this agent can actually spin up a live chat sandbox.
        // ``sandboxCapable`` is true for everything except deepagents;
        // adding the source-resolvability check hides the chat button for
        // library-mode (Python harness) agents whose ``source.type`` is
        // neither git/local nor inline-with-files. UI uses this to
        // conditionally render the "New chat" button.
        liveChatCapable: sCap && hasResolvableSource(agent.source),
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

// Hard delete — cascades to every store the agent touched: its live sandboxes
// (disposed without an auto-save), its S3 snapshots, and all Mongo rows
// (sessions, chat_sessions, chat pin, logs, messages, schedules). The registry doc
// is removed last so a mid-cascade crash leaves the agent listed (and thus
// re-deletable) rather than orphaning state under a vanished name.
agentsRouter.delete("/agents/:name", async (req, res, next) => {
  try {
    const name = req.params["name"]!;
    const registry = await registryColl();
    const existing = await registry.findOne({ _id: name });
    if (!existing) return res.status(404).json({ error: { code: "NOT_FOUND" } });

    const chatSessions = await chatSessionsColl();
    const chatDocs = await chatSessions.find({ agent: name }).toArray();
    const sessionIds = new Set(chatDocs.map((d) => d._id).filter(Boolean));

    // Cross-process side-effects first (so a future auto-save can't outlive the
    // snapshot sweep): dispose live sandboxes, then wipe the agent's S3 prefix.
    const warnings: string[] = [];
    const disp = await disposeLiveSandboxes(sessionIds);
    warnings.push(...disp.warnings);
    const snap = await deleteAgentSnapshots(name);
    warnings.push(...snap.warnings);

    // Mongo cascade. `sessions` is matched three ways to cover both store
    // shapes: gitagent uses sessionId as _id; claude-agent-sdk embeds it in
    // projectKey; the Python SDK stamps agentName on the session doc.
    const sessions = await sessionsColl();
    const sessionIdList = [...sessionIds];
    const sessionOr: Record<string, unknown>[] = [{ agentName: name } as Record<string, unknown>];
    if (sessionIdList.length > 0) {
      sessionOr.push({ _id: { $in: sessionIdList } });
      const escaped = sessionIdList.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
      sessionOr.push({ projectKey: { $regex: `(${escaped.join("|")})$` } });
    }
    const sessionsDeleted = (await sessions.deleteMany({ $or: sessionOr })).deletedCount ?? 0;

    await chatSessions.deleteMany({ agent: name });
    await (await chatPinsColl()).deleteOne({ _id: name });
    const logsDeleted = await agentLogStore.deleteByBot(name);
    const messagesDeleted = (await (await messagesColl()).deleteMany({ agentName: name })).deletedCount ?? 0;
    await scheduleStore.deleteByAgent(name);

    await registry.deleteOne({ _id: name });

    res.json({
      ok: true,
      deleted: {
        sessions: sessionsDeleted,
        snapshots: snap.deleted,
        sandboxes: disp.disposed,
        logs: logsDeleted,
        messages: messagesDeleted,
      },
      warnings,
    });
  } catch (err) { next(err); }
});
