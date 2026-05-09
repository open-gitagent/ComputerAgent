import { Hono } from "hono";
import { SendMessageBody } from "@computeragent/protocol";
import type { ServerContext } from "../app.js";
import { NotFound } from "../error-mapper.js";

/**
 * POST /v1/sessions/:id/messages — push a user message onto the session's queue.
 *
 * The engine reads from `session.userMessages()` (an AsyncIterable). This route
 * just enqueues; the SSE consumer sees responses on the existing /events stream.
 */
export function messagesRoute(ctx: ServerContext): Hono {
  const app = new Hono();

  app.post("/sessions/:id/messages", async (c) => {
    const id = c.req.param("id");
    const session = ctx.registry.get(id);
    if (!session) throw NotFound("session", id);

    const body = SendMessageBody.parse(await c.req.json());
    session.pushUserMessage(body.message);
    return c.json({ ok: true });
  });

  return app;
}
