// Request/reply audit log surface.
//   GET  /agentos/api/logs   — list, filtered by bot / before
//   POST /agentos/api/logs   — append a web-console turn

import { Router, type Router as IRouter } from "express";
import { agentLogStore } from "../stores/agent-log-store.js";
import { resolveAgentById, listReadableAgentNames } from "../agent-defs.js";
import { authorize } from "../auth/authorize.js";
import { canRead } from "../auth/ownership.js";

export const logsRouter: IRouter = Router();

logsRouter.get("/logs", authorize("logs:read"), async (req, res, next) => {
  try {
    // Scope by agent id → name (agent_logs key the per-agent `bot` field on name).
    const agentId = typeof req.query["agentId"] === "string" ? req.query["agentId"] : undefined;
    let bot: string | undefined;
    let stableId: string | null | undefined;
    let bots: string[] | undefined;
    if (agentId) {
      const agent = await resolveAgentById(agentId);
      if (!agent || !canRead(res.locals.principal, agent)) return res.json({ logs: [] });
      bot = agent.name;
      // Prefer the stable id join (survives renames); name remains the fallback.
      stableId = agent.agentId;
    } else {
      // Hard isolation — only logs for agents the caller's groups own.
      const { all, names } = await listReadableAgentNames(res.locals.principal);
      if (!all) bots = [...names];
    }
    const limit = req.query["limit"] ? parseInt(String(req.query["limit"]), 10) : 50;
    const beforeRaw = typeof req.query["before"] === "string" ? req.query["before"] : undefined;
    const before = beforeRaw ? new Date(beforeRaw) : undefined;
    const logs = await agentLogStore.list({
      ...(bot ? { bot } : {}),
      ...(stableId ? { agentId: stableId } : {}),
      ...(bots ? { bots } : {}),
      limit,
      ...(before ? { before } : {}),
    });
    res.json({ logs });
  } catch (err) { next(err); }
});

logsRouter.post("/logs", authorize("logs:write"), async (req, res, next) => {
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
