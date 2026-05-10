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
 *   2. Streams `runSession` output directly back to the client.
 *   3. Auto-deletes the session when the stream completes or the client disconnects.
 *
 * No new logic — pure transport variant of the session API. ~40 LOC of route handler.
 */
export function chatRoute(ctx: ServerContext): Hono {
  const app = new Hono();

  app.post("/chat", async (c) => {
    const body = CreateSessionBody.parse(await c.req.json());
    const session = await createSession(ctx.deps, ctx.registry, body);
    session.attachSubscriber();

    const engine = ctx.deps.engines[session.engineName];
    // engine existence already validated inside createSession; assert for type-narrowing
    if (!engine) throw new Error("engine vanished after createSession");

    return streamSSE(c, async (stream) => {
      stream.onAbort(() => {
        session.cancel();
        void ctx.registry.delete(session.sessionId);
      });
      let id = 0;
      try {
        for await (const event of runSession(engine, session)) {
          await stream.writeSSE({
            event: event.kind,
            id: String(id++),
            data: JSON.stringify(event),
          });
        }
        // Flush before close — see events.ts for the rationale.
        await stream.sleep(50);
      } finally {
        session.detachSubscriber();
        await ctx.registry.delete(session.sessionId);
      }
    });
  });

  return app;
}
