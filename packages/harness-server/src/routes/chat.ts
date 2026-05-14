import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { CreateSessionBody } from "@computeragent/protocol";
import { createSession } from "../services/create-session.js";
import { runSession } from "../services/run-session.js";
import type { ServerContext } from "../app.js";

/**
 * POST /v1/chat — one-shot convenience.
 *
 * Single POST whose response body IS the SSE stream. Internally:
 *   1. Calls the same `createSession` service the session API uses.
 *   2. Kicks off the engine drive (writes to the session's replay buffer).
 *   3. Iterates the buffer back to the wire.
 *   4. Auto-deletes the session when the stream completes or the client disconnects.
 */
export function chatRoute(ctx: ServerContext): Hono {
  const app = new Hono();

  app.post("/chat", async (c) => {
    const body = CreateSessionBody.parse(await c.req.json());
    const session = await createSession(ctx.deps, ctx.registry, body);

    const engine = ctx.deps.engines[session.engineName];
    // engine existence already validated inside createSession; assert for type-narrowing
    if (!engine) throw new Error("engine vanished after createSession");

    session.claimEngineStart();
    void runSession(engine, session);
    session.attachSubscriber();

    return streamSSE(c, async (stream) => {
      stream.onAbort(() => {
        session.cancel();
        void ctx.registry.delete(session.sessionId);
      });
      try {
        for await (const { id, event } of session.events.iterate()) {
          await stream.writeSSE({
            event: event.kind,
            id: String(id),
            data: JSON.stringify(event),
          });
        }
        await stream.sleep(50);
      } finally {
        session.detachSubscriber();
        await ctx.registry.delete(session.sessionId);
      }
    });
  });

  return app;
}
