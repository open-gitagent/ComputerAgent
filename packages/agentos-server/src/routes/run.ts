// One-shot SSE run — used by deepagents (no warm sandbox) and as a generic
// "run this agent against a prompt and stream me the result" endpoint.

import { Router, type Router as IRouter } from "express";
import { caAuthHeader } from "../auth.js";
import { caBase, pipeUpstream } from "../upstream.js";
import { resolveAgentById, runBodyFor, srsPolicyForAgent } from "../agent-defs.js";

export const runRouter: IRouter = Router();

runRouter.post("/agents/:id/run", async (req, res, next) => {
  try {
    const agent = await resolveAgentById(req.params["id"]!);
    if (!agent) return res.status(404).json({ error: { code: "UNKNOWN_AGENT" } });
    const message = String((req.body as Record<string, unknown> | undefined)?.["message"] ?? "");

    let body: Record<string, unknown>;
    try {
      body = runBodyFor(agent, message);
    } catch (err) {
      const status = (err as any)?.status ?? 503;
      return res.status(status).json({ error: { code: "AGENT_CONFIG", message: (err as Error).message } });
    }
    // Attach the agent's bound SRS policy (if any). Enforced by the harness's
    // always-on PreToolUse hook, so bypassPermissions autonomy is preserved.
    const policy = await srsPolicyForAgent(agent.name);
    if (policy) body.policy = policy;

    const upstream = await fetch(`${caBase()}/run`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream", ...caAuthHeader() },
      body: JSON.stringify(body),
    });
    await pipeUpstream(upstream, res);
  } catch (err) { next(err); }
});
