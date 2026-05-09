import { Hono } from "hono";
import type { ServerContext } from "../app.js";
import { NotFound } from "../error-mapper.js";

/**
 * POST /v1/sessions/:id/cancel — abort the engine.
 *
 * Triggers Session.cancel(): aborts the AbortController the engine is observing,
 * resolves any pending permission promises with `deny`, and ends the user-message
 * queue. The SSE stream then emits a terminal `ca_session_ended { reason: "cancelled" }`.
 */
export function cancelRoute(ctx: ServerContext): Hono {
  const app = new Hono();

  app.post("/sessions/:id/cancel", (c) => {
    const id = c.req.param("id");
    const session = ctx.registry.get(id);
    if (!session) throw NotFound("session", id);
    session.cancel();
    return c.json({ ok: true });
  });

  return app;
}
