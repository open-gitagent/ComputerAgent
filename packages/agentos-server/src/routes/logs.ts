// Request/reply audit log surface.
//   GET  /agentos/api/logs   — list, filtered by bot / before
//   POST /agentos/api/logs   — append a web-console turn

import { Router, type Router as IRouter } from "express";
import { agentLogStore } from "../stores/agent-log-store.js";

export const logsRouter: IRouter = Router();

logsRouter.get("/logs", async (req, res, next) => {
  try {
    const bot = typeof req.query["bot"] === "string" ? req.query["bot"] : undefined;
    const limit = req.query["limit"] ? parseInt(String(req.query["limit"]), 10) : 50;
    const beforeRaw = typeof req.query["before"] === "string" ? req.query["before"] : undefined;
    const before = beforeRaw ? new Date(beforeRaw) : undefined;
    const logs = await agentLogStore.list({
      ...(bot ? { bot } : {}),
      limit,
      ...(before ? { before } : {}),
    });
    res.json({ logs });
  } catch (err) { next(err); }
});

logsRouter.post("/logs", async (req, res, next) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    await agentLogStore.append({
      source: "web",
      bot: String(body["bot"] ?? "unknown"),
      requester: String(body["requester"] ?? "web"),
      channel: null,
      threadTs: null,
      sessionId: body["sessionId"] ? String(body["sessionId"]) : null,
      query: String(body["query"] ?? ""),
      reply: String(body["reply"] ?? ""),
      ok: body["ok"] !== false,
    });
    res.json({ ok: true });
  } catch (err) { next(err); }
});
