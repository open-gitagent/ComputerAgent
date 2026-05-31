import { Hono } from "hono";
import { CreateSessionBody, type CreateSessionResponse } from "@open-gitagent/protocol";
import { createSession } from "../services/create-session.js";
import type { ServerContext } from "../app.js";
import { NotFound } from "../error-mapper.js";

/**
 * Build session-lifecycle routes:
 *   POST   /v1/sessions
 *   GET    /v1/sessions/:id          — metadata only
 *   DELETE /v1/sessions/:id
 */
export function sessionsRoute(ctx: ServerContext): Hono {
  const app = new Hono();

  app.post("/sessions", async (c) => {
    ctx.deps.logger.debug("http.request", { method: "POST", path: "/v1/sessions" });
    const body = CreateSessionBody.parse(await c.req.json());
    const session = await createSession(ctx.deps, ctx.registry, body);
    const response: CreateSessionResponse = {
      sessionId: session.sessionId,
      engine: session.engineName,
      identity: session.identity,
      capabilities: session.capabilities,
      eventsUrl: `/v1/sessions/${session.sessionId}/events`,
    };
    return c.json(response, 201);
  });

  app.get("/sessions/:id", (c) => {
    const id = c.req.param("id");
    ctx.deps.logger.debug("http.request", { method: "GET", path: "/v1/sessions/:id", sessionId: id });
    const session = ctx.registry.get(id);
    if (!session) throw NotFound("session", id);
    return c.json({
      sessionId: session.sessionId,
      engine: session.engineName,
      identity: session.identity,
      status: session.status,
    });
  });

  app.delete("/sessions/:id", async (c) => {
    const id = c.req.param("id");
    ctx.deps.logger.debug("http.request", { method: "DELETE", path: "/v1/sessions/:id", sessionId: id });
    const session = ctx.registry.get(id);
    if (!session) throw NotFound("session", id);
    session.cancel();
    await ctx.registry.delete(id);
    return c.json({ ok: true });
  });

  return app;
}
