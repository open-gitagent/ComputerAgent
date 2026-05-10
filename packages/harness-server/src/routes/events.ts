import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { ServerContext } from "../app.js";
import { Conflict, NotFound } from "../error-mapper.js";
import { runSession } from "../services/run-session.js";

/**
 * GET /v1/sessions/:id/events — SSE stream.
 *
 * One subscriber per session for MVP. The first GET kicks off the engine; a second
 * concurrent GET gets 409 CONFLICT. Multi-client fan-out is a Wedge 1.5 concern.
 */
export function eventsRoute(ctx: ServerContext): Hono {
  const app = new Hono();

  app.get("/sessions/:id/events", (c) => {
    const id = c.req.param("id");
    const session = ctx.registry.get(id);
    if (!session) throw NotFound("session", id);

    const engine = ctx.deps.engines[session.engineName];
    if (!engine) throw NotFound("engine", session.engineName);

    if (!session.attachSubscriber()) {
      throw Conflict("ALREADY_SUBSCRIBED", "session already has an SSE subscriber");
    }

    return streamSSE(c, async (stream) => {
      stream.onAbort(() => session.detachSubscriber());
      let id = 0;
      try {
        for await (const event of runSession(engine, session)) {
          await stream.writeSSE({
            event: event.kind,
            id: String(id++),
            data: JSON.stringify(event),
          });
        }
        // Give Bun's HTTP layer a tick to flush the chunked-encoding terminator
        // before stream.close() tears down the socket. Without this, curl can
        // exit with code 18 ("partial file") even on a clean run.
        await stream.sleep(50);
      } finally {
        session.detachSubscriber();
      }
    });
  });

  return app;
}
