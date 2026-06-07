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
import { hasResolvableSource, normalizeSource, registryDocToAgentDef, resolveAgentById, sandboxCapable } from "../agent-defs.js";
import { authorize } from "../auth/authorize.js";
import { canRead, canWrite, pickOwnerGroup } from "../auth/ownership.js";

export const agentsRouter: IRouter = Router();

agentsRouter.get("/agents", authorize("agents:read"), async (_req, res, next) => {
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
      // Hard isolation — only surface agents the principal's groups own (admins
      // see all; legacy/unowned rows stay visible during the transition).
      if (!canRead(res.locals.principal, r)) continue;
      const agent = registryDocToAgentDef(r);
      // Prefer the stable agentId join (survives renames); name as fallback.
      const docs = await chatSessions
        .find(r.agentId ? { $or: [{ agentId: r.agentId }, { agent: agent.name }] } : { agent: agent.name })
        .toArray();
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
        id: agent.id,
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
        // Archive state — archived agents are still returned (the UI lists them
        // in a separate, greyed "Archived" section) but every execution path
        // refuses them. Unset/false ⇒ active.
        archived: r.archived === true,
        archivedAt: r.archivedAt ? r.archivedAt.toISOString() : null,
        ownerGroup: r.ownerGroup ?? null,
        ownerUser: r.ownerUser ?? null,
        sessionCount: sessionIds.size,
        activeSandboxes: active,
        lastActivity: lastActivity ? lastActivity.toISOString() : null,
        logCount: await agentLogStore.count(agent.name),
      });
    }
    res.json({ agents: out });
  } catch (err) { next(err); }
});

agentsRouter.get("/agents/by-source", authorize("agents:read"), async (req, res, next) => {
  try {
    const url = typeof req.query["url"] === "string" ? req.query["url"] : "";
    if (!url) return res.status(400).json({ error: { code: "BAD_REQUEST", message: "`url` required" } });
    const rows = await (await registryColl()).find({}).toArray();
    const matches = rows
      .filter((r) => canRead(res.locals.principal, r))
      .map((r) => ({ id: r._id.toString(), name: r.name, ...normalizeSource(r.source) }))
      .filter((m) => m.sourceUrl === url);
    res.json({ url, matches });
  } catch (err) { next(err); }
});

// Resolve a registered agent's run definition by its STABLE `agentId` — lets an
// SDK consumer run an agent by reference (pass only `agent_id`) and fetch its
// source/harness/model from AgentOS instead of repeating them. Strictly
// group-scoped (the cak_ key's group must be able to read the agent); unknown
// or unreadable → 404 (no existence leak). Mirrors git-credentials/resolve.
agentsRouter.post("/agents/resolve", authorize("agents:read"), async (req, res, next) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const agentId = typeof body["agentId"] === "string" ? body["agentId"].trim() : "";
    if (!agentId) {
      return res.status(400).json({ error: { code: "BAD_REQUEST", message: "`agentId` required" } });
    }
    const doc = await (await registryColl()).findOne({ agentId });
    if (!doc || !canRead(res.locals.principal, doc)) {
      return res.status(404).json({ error: { code: "NOT_FOUND", message: `no agent with agentId=${agentId}` } });
    }
    const def = registryDocToAgentDef(doc);
    res.json({
      agentId,
      name: def.name,
      source: def.source, // string URL/path OR a full inline IdentitySource object
      harness: def.harness,
      ...(def.model ? { model: def.model } : {}),
    });
  } catch (err) { next(err); }
});

agentsRouter.post("/agents/register", authorize("agents:write"), async (req, res, next) => {
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

    // Ownership. Register is an upsert: updating an existing agent requires
    // write access (owner-user or admin); creating one stamps the owner —
    // ownerUser = the creator, ownerGroup = a group the creator belongs to
    // (chosen via `ownerGroup`, defaulting to their first group).
    const principal = res.locals.principal;
    const coll = await registryColl();
    const existing = await coll.findOne({ name });
    if (existing && !canWrite(principal, existing)) {
      return res.status(403).json({ error: { code: "NOT_OWNER", message: "you do not own this agent" } });
    }
    const insert: Partial<RegistryDoc> = { name, registeredAt: now };
    if (!existing) {
      if (!principal) return res.status(401).json({ error: { code: "UNAUTHENTICATED" } });
      const pick = pickOwnerGroup(principal, body["ownerGroup"]);
      if (!pick.ok) {
        return res.status(403).json({ error: { code: "OWNER_GROUP_NOT_ALLOWED", message: "not a member of the requested group" } });
      }
      insert.ownerGroup = pick.group;
      insert.ownerUser = principal.id;
      if (!set.registeredBy) set.registeredBy = principal.id;
    }
    // Upsert by the unique `name`; Mongo mints the ObjectId `_id` on insert.
    await coll.updateOne({ name }, { $set: set, $setOnInsert: insert }, { upsert: true });
    const doc = await coll.findOne({ name });
    res.json({ ok: true, id: doc?._id.toString() ?? null, name });
  } catch (err) { next(err); }
});

agentsRouter.patch("/agents/:id", authorize("agents:write"), async (req, res, next) => {
  try {
    const agent = await resolveAgentById(req.params["id"]!);
    if (!agent) return res.status(404).json({ error: { code: "NOT_FOUND" } });
    if (!canWrite(res.locals.principal, agent)) return res.status(403).json({ error: { code: "NOT_OWNER", message: "you do not own this agent" } });
    const body = (req.body ?? {}) as Record<string, unknown>;
    const set: Partial<RegistryDoc> = { updatedAt: new Date() };
    if (typeof body["label"] === "string") set.label = body["label"];
    if (typeof body["harness"] === "string") set.harness = body["harness"];
    if (body["source"] !== undefined) set.source = body["source"];
    if (typeof body["model"] === "string") set.model = body["model"];
    // Update by surrogate id (name stays the immutable FK across collections).
    await (await registryColl()).updateOne({ name: agent.name }, { $set: set });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// Archive — a reversible "off switch". Sets the archived flag, then makes the
// agent immediately non-executable: dispose its live warm sandboxes (so an
// in-flight chat can't keep running) and disable its bound schedules. History
// (sessions, logs, messages, snapshots) is preserved — this is NOT a delete.
agentsRouter.post("/agents/:id/archive", authorize("agents:write"), async (req, res, next) => {
  try {
    const agent = await resolveAgentById(req.params["id"]!);
    if (!agent) return res.status(404).json({ error: { code: "NOT_FOUND" } });
    if (!canWrite(res.locals.principal, agent)) return res.status(403).json({ error: { code: "NOT_OWNER", message: "you do not own this agent" } });
    const name = agent.name;
    const set: Partial<RegistryDoc> = { archived: true, archivedAt: new Date(), updatedAt: new Date() };
    const by = (req.body as Record<string, unknown> | undefined)?.["archivedBy"];
    if (typeof by === "string" && by) set.archivedBy = by;
    await (await registryColl()).updateOne({ name }, { $set: set });

    // Tear down running sandboxes for this agent's sessions, then stop schedules.
    const chatFilter = agent.agentId
      ? { $or: [{ agentId: agent.agentId }, { agent: name }] }
      : { agent: name };
    const chatDocs = await (await chatSessionsColl()).find(chatFilter).toArray();
    const sessionIds = new Set(chatDocs.map((d) => d._id).filter(Boolean));
    const disp = await disposeLiveSandboxes(sessionIds);
    const schedulesDisabled = await scheduleStore.disableByAgent(name);

    res.json({ ok: true, disposed: disp.disposed, schedulesDisabled, warnings: disp.warnings });
  } catch (err) { next(err); }
});

// Unarchive — clear the flag so the agent is runnable again. Schedules are NOT
// auto-re-enabled (the user re-enables intentionally); sandboxes re-boot lazily
// on the next chat.
agentsRouter.post("/agents/:id/unarchive", authorize("agents:write"), async (req, res, next) => {
  try {
    const agent = await resolveAgentById(req.params["id"]!);
    if (!agent) return res.status(404).json({ error: { code: "NOT_FOUND" } });
    if (!canWrite(res.locals.principal, agent)) return res.status(403).json({ error: { code: "NOT_OWNER", message: "you do not own this agent" } });
    await (await registryColl()).updateOne(
      { name: agent.name },
      { $set: { archived: false, updatedAt: new Date() }, $unset: { archivedAt: "", archivedBy: "" } },
    );
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// Hard delete — cascades to every store the agent touched: its live sandboxes
// (disposed without an auto-save), its S3 snapshots, and all Mongo rows
// (sessions, chat_sessions, chat pin, logs, messages, schedules). The registry doc
// is removed last so a mid-cascade crash leaves the agent listed (and thus
// re-deletable) rather than orphaning state under a vanished name.
agentsRouter.delete("/agents/:id", authorize("agents:delete"), async (req, res, next) => {
  try {
    const agent = await resolveAgentById(req.params["id"]!);
    if (!agent) return res.status(404).json({ error: { code: "NOT_FOUND" } });
    if (!canWrite(res.locals.principal, agent)) return res.status(403).json({ error: { code: "NOT_OWNER", message: "you do not own this agent" } });
    const name = agent.name;
    const registry = await registryColl();

    const agentId = agent.agentId ?? null;
    const chatFilter = agentId ? { $or: [{ agentId }, { agent: name }] } : { agent: name };
    const chatSessions = await chatSessionsColl();
    const chatDocs = await chatSessions.find(chatFilter).toArray();
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
    if (agentId) sessionOr.push({ agentId });
    if (sessionIdList.length > 0) {
      sessionOr.push({ _id: { $in: sessionIdList } });
      const escaped = sessionIdList.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
      sessionOr.push({ projectKey: { $regex: `(${escaped.join("|")})$` } });
    }
    const sessionsDeleted = (await sessions.deleteMany({ $or: sessionOr })).deletedCount ?? 0;

    await chatSessions.deleteMany(chatFilter);
    await (await chatPinsColl()).deleteOne({ agentName: name });
    const logsDeleted = await agentLogStore.deleteByBot(name, agentId);
    // Messages stay sessionId-linked; cover renamed-session rows via the id list.
    const msgOr: Record<string, unknown>[] = [{ agentName: name }];
    if (sessionIdList.length > 0) msgOr.push({ sessionId: { $in: sessionIdList } });
    const messagesDeleted = (await (await messagesColl()).deleteMany({ $or: msgOr })).deletedCount ?? 0;
    await scheduleStore.deleteByAgent(name);

    await registry.deleteOne({ name });

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
