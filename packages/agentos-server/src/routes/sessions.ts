// Sessions tab — list (slack_threads) + transcript (sessions).
//
// The harness owns writes to the `sessions` collection via its sessionStore
// plugin. We just read here and normalize across the two storage shapes
// (gitagent uses sessionId as _id; claude-agent-sdk embeds it in projectKey).

import { Router, type Router as IRouter } from "express";
import { sessionsColl, threadsColl } from "../mongo.js";

export const sessionsRouter: IRouter = Router();

sessionsRouter.get("/sessions", async (req, res, next) => {
  try {
    const bot = typeof req.query["bot"] === "string" ? req.query["bot"] : undefined;
    const limit = Math.min(
      Math.max(parseInt(String(req.query["limit"] ?? "50"), 10) || 50, 1),
      200,
    );
    const q = bot ? { bot } : {};
    const docs = await (await threadsColl())
      .find(q)
      .sort({ lastMessageAt: -1 })
      .limit(limit)
      .toArray();
    res.json({
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
  } catch (err) { next(err); }
});

sessionsRouter.get("/sessions/:id", async (req, res, next) => {
  try {
    const id = req.params["id"]!;
    const [sessions, threads] = [await sessionsColl(), await threadsColl()];
    const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const session =
      (await sessions.findOne({ _id: id })) ??
      (await sessions.findOne({ projectKey: { $regex: `${escapedId}$` } }));
    const thread = await threads.findOne({ sessionId: id });

    res.json({
      sessionId: id,
      thread: thread
        ? {
            bot: thread.bot, channel: thread.channel, threadTs: thread.threadTs,
            sandboxId: thread.sandboxId ?? null, snapshotId: thread.snapshotId ?? null,
            lastMessageAt: thread.lastMessageAt ? new Date(thread.lastMessageAt).toISOString() : null,
          }
        : null,
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
