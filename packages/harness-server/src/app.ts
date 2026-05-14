import { Hono } from "hono";
import type { EngineDriver, IdentityLoader } from "@computeragent/protocol";
import type { AuditSink } from "./audit.js";
import type { AuthHandler } from "./auth.js";
import { onError, ProtocolError } from "./error-mapper.js";
import { DEFAULT_STORE_BUILDERS, type SessionStoreRegistry } from "./stores/registry.js";
import { healthRoute } from "./routes/health.js";
import { sessionsRoute } from "./routes/sessions.js";
import { eventsRoute } from "./routes/events.js";
import { chatRoute } from "./routes/chat.js";
import { messagesRoute } from "./routes/messages.js";
import { cancelRoute } from "./routes/cancel.js";
import { fsRoute } from "./routes/fs.js";
import { permissionRoute } from "./routes/permission.js";
import { endInputRoute } from "./routes/end-input.js";
import { SessionRegistry } from "./registry.js";

/** Public configuration passed by the host application. */
export interface CreateHarnessServerOptions {
  readonly engines: Readonly<Record<string, EngineDriver>>;
  readonly identityLoaders: Readonly<Record<string, IdentityLoader>>;
  /** Optional override for session TTL in milliseconds. */
  readonly sessionTtlMs?: number;
  /** Optional audit sink — every emitted event is teed to it. Errors are swallowed. */
  readonly auditSink?: AuditSink;
  /** Optional auth handler. Default: no-auth (appropriate only for loopback). */
  readonly authHandler?: AuthHandler;
  /** Paths excluded from auth even when an authHandler is set. Default: ["/v1/health"]. */
  readonly authPublicPaths?: readonly string[];
  /**
   * Optional swappable SessionStore builders, keyed by `kind`. Merged on top
   * of built-in `memory` and `file` kinds — users can override defaults or
   * add new ones (`mongo`, `redis`, etc.) without forking the framework.
   */
  readonly sessionStores?: SessionStoreRegistry;
}

/** Plug-in references — handed to route modules that need engines/loaders. */
export interface ServerDeps {
  readonly engines: Readonly<Record<string, EngineDriver>>;
  readonly identityLoaders: Readonly<Record<string, IdentityLoader>>;
  readonly auditSink?: AuditSink;
  readonly sessionStores: SessionStoreRegistry;
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
    deps: {
      engines: opts.engines,
      identityLoaders: opts.identityLoaders,
      ...(opts.auditSink ? { auditSink: opts.auditSink } : {}),
      sessionStores: { ...DEFAULT_STORE_BUILDERS, ...(opts.sessionStores ?? {}) },
    },
    registry: new SessionRegistry(opts.sessionTtlMs),
  };

  const app = new Hono();
  app.onError(onError);

  if (opts.authHandler) {
    const handler = opts.authHandler;
    const publicPaths = new Set(opts.authPublicPaths ?? ["/v1/health"]);
    app.use("/v1/*", async (c, next) => {
      if (publicPaths.has(c.req.path)) return next();
      const result = await handler.authenticate({
        method: c.req.method,
        path: c.req.path,
        headers: new Headers(c.req.raw.headers),
      });
      if (!result) {
        throw new ProtocolError(401, "UNAUTHORIZED", "authentication required");
      }
      // AuthContext is available to handlers via c.req.raw.headers if they
      // need it; we don't attach it to c.var to avoid coupling every route
      // to a typed Hono Variables map.
      return next();
    });
  }

  app.route("/v1", healthRoute(ctx));
  app.route("/v1", sessionsRoute(ctx));
  app.route("/v1", eventsRoute(ctx));
  app.route("/v1", chatRoute(ctx));
  app.route("/v1", messagesRoute(ctx));
  app.route("/v1", cancelRoute(ctx));
  app.route("/v1", fsRoute(ctx));
  app.route("/v1", permissionRoute(ctx));
  app.route("/v1", endInputRoute(ctx));
  return app;
}
