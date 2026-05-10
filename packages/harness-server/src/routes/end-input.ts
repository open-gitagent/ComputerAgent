import { Hono } from "hono";
import type { ServerContext } from "../app.js";
import { NotFound } from "../error-mapper.js";

/**
 * POST /v1/sessions/:id/end-input — close the session's user-message queue.
 *
 * Used in streaming-input mode (`createSession` body had `streamingInput: true`)
 * to signal that no more user messages will arrive. The engine then sees its
 * input iterator end and completes the turn.
 */
export function endInputRoute(ctx: ServerContext): Hono {
  const app = new Hono();

  app.post("/sessions/:id/end-input", (c) => {
    const id = c.req.param("id");
    const session = ctx.registry.get(id);
    if (!session) throw NotFound("session", id);
    session.endUserMessages();
    return c.json({ ok: true });
  });

  return app;
}
