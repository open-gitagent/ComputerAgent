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
import { warmSessions } from "../upstream.js";

export const sessionsRouter: IRouter = Router();

sessionsRouter.get("/sessions", async (req, res, next) => {
  try {
    const bot = typeof req.query["bot"] === "string" ? req.query["bot"] : undefined;
    const limit = Math.min(
      Math.max(parseInt(String(req.query["limit"] ?? "50"), 10) || 50, 1),
      200,
    );
    const q = bot ? { agent: bot } : {};
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

sessionsRouter.get("/sessions/:id", async (req, res, next) => {
  try {
    const id = req.params["id"]!;
    const sessions = await sessionsColl();
    const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const session =
      (await sessions.findOne({ _id: id })) ??
      (await sessions.findOne({ projectKey: { $regex: `${escapedId}$` } }));
    const [chat, warm] = await Promise.all([
      (await chatSessionsColl()).findOne({ _id: id }),
      warmSessions(),
    ]);

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
// from the chat_sessions row's `agent`; pass `?bot=<name>` for sessions that
// never got one. The chat pin is only cleared when it points at this session.
sessionsRouter.delete("/sessions/:id", async (req, res, next) => {
  try {
    const id = req.params["id"]!;
    const chatSessions = await chatSessionsColl();
    const chat = await chatSessions.findOne({ _id: id });
    const bot = (typeof req.query["bot"] === "string" && req.query["bot"]) || chat?.agent || null;

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
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const sessionsDeleted = (await sessions.deleteMany({
      $or: [{ _id: id }, { projectKey: { $regex: `${escaped}$` } }],
    })).deletedCount ?? 0;

    await chatSessions.deleteOne({ _id: id });
    const logsDeleted = await agentLogStore.deleteBySession(id);
    const messagesDeleted = (await (await messagesColl()).deleteMany({ sessionId: id })).deletedCount ?? 0;
    if (bot) await (await chatPinsColl()).deleteOne({ _id: bot, sessionId: id });

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
