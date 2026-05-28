import { Hono } from "hono";
import type { HealthResponse } from "@open-gitagent/protocol";
import type { ServerContext } from "../app.js";

const HARNESS_VERSION = "0.1.0";

/**
 * Build the `/v1/health` route. Returns a snapshot of registered engines + loaders
 * with their declared capabilities. Clients use this for capability negotiation.
 */
export function healthRoute(ctx: ServerContext): Hono {
  const app = new Hono();

  app.get("/health", (c) => {
    const engines: HealthResponse["engines"] = {};
    for (const [name, engine] of Object.entries(ctx.deps.engines)) {
      engines[name] = { ...engine.capabilities };
    }
    const body: HealthResponse = {
      ok: true,
      version: HARNESS_VERSION,
      engines,
      loaders: Object.keys(ctx.deps.identityLoaders),
    };
    return c.json(body, 200);
  });

  return app;
}
