import { Hono } from "hono";
import type { EngineDriver, IdentityLoader } from "@computeragent/protocol";
import { onError } from "./error-mapper.js";
import { healthRoute } from "./routes/health.js";
import { sessionsRoute } from "./routes/sessions.js";
import { eventsRoute } from "./routes/events.js";
import { chatRoute } from "./routes/chat.js";
import { SessionRegistry } from "./registry.js";

/** Public configuration passed by the host application. */
export interface CreateHarnessServerOptions {
  readonly engines: Readonly<Record<string, EngineDriver>>;
  readonly identityLoaders: Readonly<Record<string, IdentityLoader>>;
  /** Optional override for session TTL in milliseconds. */
  readonly sessionTtlMs?: number;
}

/** Plug-in references — handed to route modules that need engines/loaders. */
export interface ServerDeps {
  readonly engines: Readonly<Record<string, EngineDriver>>;
  readonly identityLoaders: Readonly<Record<string, IdentityLoader>>;
}

/** Full per-server context — deps plus the (mutable) session registry. */
export interface ServerContext {
  readonly deps: ServerDeps;
  readonly registry: SessionRegistry;
}

/**
 * Factory: builds a Hono app for the Harness Protocol with the given plug-ins.
 *
 * Pattern: Factory + Dependency Inversion — `harness-server` depends on the
 * `EngineDriver`/`IdentityLoader` interfaces only; concrete plug-ins are passed in.
 */
export function createHarnessServer(opts: CreateHarnessServerOptions): Hono {
  if (Object.keys(opts.engines).length === 0) {
    throw new Error("createHarnessServer: at least one engine must be registered");
  }
  if (Object.keys(opts.identityLoaders).length === 0) {
    throw new Error("createHarnessServer: at least one identity loader must be registered");
  }

  const ctx: ServerContext = {
    deps: { engines: opts.engines, identityLoaders: opts.identityLoaders },
    registry: new SessionRegistry(opts.sessionTtlMs),
  };

  const app = new Hono();
  app.onError(onError);
  app.route("/v1", healthRoute(ctx));
  app.route("/v1", sessionsRoute(ctx));
  app.route("/v1", eventsRoute(ctx));
  app.route("/v1", chatRoute(ctx));
  return app;
}
