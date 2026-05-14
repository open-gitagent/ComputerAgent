import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { ServerContext } from "../app.js";
import { NotFound } from "../error-mapper.js";
import { runSession } from "../services/run-session.js";

/**
 * GET /v1/sessions/:id/events — SSE stream.
 *
 * Engine drive is per-session: the first GET kicks it off, every subsequent
 * GET reads from the same replay buffer. Reconnecting clients can supply
 * `Last-Event-ID: N` (or `?lastEventId=N`) to skip events ≤ N — the buffer
 * replays any retained events with id > N then tails new ones as they arrive.
 *
 * If `Last-Event-ID` is older than the buffer's retained tail, the client has
 * fallen behind the ring; they get partial replay, which is better than silent
 * data loss but should be surfaced to the application layer for reconciliation.
 */
export function eventsRoute(ctx: ServerContext): Hono {
  const app = new Hono();

  app.get("/sessions/:id/events", (c) => {
    const id = c.req.param("id");
    const session = ctx.registry.get(id);
    if (!session) throw NotFound("session", id);

    const engine = ctx.deps.engines[session.engineName];
    if (!engine) throw NotFound("engine", session.engineName);

    const lastEventId = parseLastEventId(c.req.header("Last-Event-ID"), c.req.query("lastEventId"));

    if (session.claimEngineStart()) {
      void runSession(engine, session);
    }
    session.attachSubscriber();

    return streamSSE(c, async (stream) => {
      stream.onAbort(() => session.detachSubscriber());
      try {
        for await (const { id: eventId, event } of session.events.iterate({ since: lastEventId })) {
          await stream.writeSSE({
            event: event.kind,
            id: String(eventId),
            data: JSON.stringify(event),
          });
        }
        // Give the HTTP layer a tick to flush the chunked-encoding terminator
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

function parseLastEventId(header: string | undefined, query: string | undefined): number {
  const raw = header ?? query;
  if (!raw) return -1;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : -1;
}
