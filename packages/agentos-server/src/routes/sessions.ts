// Sessions tab — list (chat_sessions) + transcript (sessions).
//
// The harness owns writes to the `sessions` collection via its sessionStore
// plugin. We just read here and normalize across the two storage shapes
// (gitagent uses sessionId as _id; claude-agent-sdk embeds it in projectKey).
// The web chat session index lives in our own `chat_sessions` collection;
// "warm" is queried live from the harness sandbox registry, never stored.

import { Router, type Router as IRouter } from "express";
import { chatPinsColl, chatSessionsColl, messagesColl, sessionsColl } from "../mongo.js";
import { agentLogStore } from "../stores/agent-log-store.js";
import { deleteAgentSnapshots, disposeLiveSandboxes } from "../cleanup.js";
import { resolveAgent, resolveAgentById, listReadableAgentNames } from "../agent-defs.js";
import { warmSessions } from "../upstream.js";
import { authorize } from "../auth/authorize.js";
import { canRead } from "../auth/ownership.js";

export const sessionsRouter: IRouter = Router();

// The durable `sessions` row is keyed by the harness sessionId (the pinned
// store unifies `_id` across chat_sessions / transcript / gitagent). As a
// safety net for rows NOT written through the pin (older sessions, or engines
// that derive their own key), we also match by `projectKey` suffix. The Claude
// CLI derives projectKey from the workdir path, replacing path separators,
// spaces, and other punctuation with "-": a sessionId like
// "agentos-General Agent-abc" lands as "...-agentos-General-Agent-abc". So a
// literal regex with the original space never matches. Build a LOOSE suffix
// regex where every run of non-alphanumerics in the id matches one-or-more
// non-alphanumerics in the stored projectKey.
function looseProjectKeySuffix(id: string): string {
  const tokens = id
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return `${tokens.join("[^a-zA-Z0-9]+")}$`;
}

sessionsRouter.get("/sessions", authorize("sessions:read"), async (req, res, next) => {
  try {
    const agentId = typeof req.query["agentId"] === "string" ? req.query["agentId"] : undefined;
    const limit = Math.min(
      Math.max(parseInt(String(req.query["limit"] ?? "50"), 10) || 50, 1),
      200,
    );
    // Scope to one agent by resolving its id → name (chat_sessions keys on name).
    // An id that doesn't resolve returns no sessions rather than leaking all.
    let q: Record<string, unknown> = {};
    if (agentId) {
      const agent = await resolveAgentById(agentId);
      // Unknown id OR not in the caller's groups → no sessions (no leak).
      if (!agent || !canRead(res.locals.principal, agent)) return res.json({ sessions: [] });
      // Prefer the stable agentId join (survives renames); fall back to name so
      // pre-agentId history still resolves.
      q = agent.agentId
        ? { $or: [{ agentId: agent.agentId }, { agent: agent.name }] }
        : { agent: agent.name };
    } else {
      // Hard isolation — only sessions for agents the caller's groups own.
      const { all, names } = await listReadableAgentNames(res.locals.principal);
      if (!all) q = { agent: { $in: [...names] } };
    }
    const [docs, warm] = await Promise.all([
      (await chatSessionsColl()).find(q).sort({ lastMessageAt: -1 }).limit(limit).toArray(),
      warmSessions(),
    ]);
    res.json({
      sessions: docs.map((d) => ({
        sessionId: d._id,
        bot: d.agent,
        warm: warm.has(d._id),
        createdAt: d.createdAt ? new Date(d.createdAt).toISOString() : null,
        lastMessageAt: d.lastMessageAt ? new Date(d.lastMessageAt).toISOString() : null,
      })),
    });
  } catch (err) { next(err); }
});

sessionsRouter.get("/sessions/:id", authorize("sessions:read"), async (req, res, next) => {
  try {
    const id = req.params["id"]!;
    const sessions = await sessionsColl();
    const session =
      (await sessions.findOne({ _id: id })) ??
      (await sessions.findOne({ projectKey: { $regex: looseProjectKeySuffix(id) } }));
    const [chat, warm] = await Promise.all([
      (await chatSessionsColl()).findOne({ _id: id }),
      warmSessions(),
    ]);

    // Hard isolation — a session belongs to its agent's group.
    if (chat?.agent) {
      const owner = await resolveAgent(chat.agent);
      if (owner && !canRead(res.locals.principal, owner)) {
        return res.status(403).json({ error: { code: "NOT_OWNER" } });
      }
    }

    res.json({
      sessionId: id,
      bot: chat?.agent ?? null,
      warm: warm.has(id),
      updatedAt: session?.updatedAt ? new Date(session.updatedAt).toISOString() : null,
      entries: (session?.entries ?? [])
        .map((raw) => {
          const e = raw as Record<string, unknown>;
          if (e["type"] === "queue-operation") return { type: "meta", text: "" };
          const message = (e["message"] ?? null) as { role?: string; content?: unknown } | null;
          const role = (message?.role as string | undefined) ?? (e["type"] as string | undefined) ?? "assistant";
          const content: unknown = message?.content ?? e["content"] ?? e["text"];
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
  } catch (err) { next(err); }
});

// Hard delete one session — disposes its live sandbox (no auto-save), deletes
// its S3 snapshots, and removes the session transcript + chat_sessions row +
// logs + messages. The S3 prefix is per-agent, so the owning agent is resolved
// from the chat_sessions row's `agent`; pass `?agentId=<id>` for sessions that
// never got one. The chat pin is only cleared when it points at this session.
sessionsRouter.delete("/sessions/:id", authorize("sessions:delete"), async (req, res, next) => {
  try {
    const id = req.params["id"]!;
    const chatSessions = await chatSessionsColl();
    const chat = await chatSessions.findOne({ _id: id });
    const agentId = typeof req.query["agentId"] === "string" ? req.query["agentId"] : undefined;
    const fallback = agentId ? (await resolveAgentById(agentId))?.name : undefined;
    const bot = chat?.agent || fallback || null;

    const warnings: string[] = [];
    const disp = await disposeLiveSandboxes(new Set([id]));
    warnings.push(...disp.warnings);
    let snapshotsDeleted = 0;
    if (bot) {
      const snap = await deleteAgentSnapshots(bot, { sessionId: id });
      snapshotsDeleted = snap.deleted;
      warnings.push(...snap.warnings);
    } else {
      warnings.push("no owning agent resolved for session — skipped S3 snapshot cleanup");
    }

    const sessions = await sessionsColl();
    const sessionsDeleted = (await sessions.deleteMany({
      $or: [{ _id: id }, { projectKey: { $regex: looseProjectKeySuffix(id) } }],
    })).deletedCount ?? 0;

    await chatSessions.deleteOne({ _id: id });
    const logsDeleted = await agentLogStore.deleteBySession(id);
    const messagesDeleted = (await (await messagesColl()).deleteMany({ sessionId: id })).deletedCount ?? 0;
    if (bot) await (await chatPinsColl()).deleteOne({ agentName: bot, sessionId: id });

    res.json({
      ok: true,
      deleted: {
        sessions: sessionsDeleted,
        snapshots: snapshotsDeleted,
        sandboxes: disp.disposed,
        logs: logsDeleted,
        messages: messagesDeleted,
      },
      warnings,
    });
  } catch (err) { next(err); }
});
