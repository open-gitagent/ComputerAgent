// HTTP app composition — builds the whole Express tree and returns it. Kept
// separate from index.ts so the wiring is unit-testable (no listen) and the
// trust boundaries are visible in one place.
//
// Three boundaries, three guard regimes:
//   SERVICE      /agentos/api/{ingest,keys}  — own bearer guards, before global
//                                              json/cookie (large/limited bodies)
//   DASHBOARD    /agentos/api/v1/*           — authenticate (+ Stage 2 authorize)
//   OBSERVABILITY /v1/*                       — authenticate (read-only)
//
import express, { type Express } from "express";
import cookieParser from "cookie-parser";
import cors from "cors";

import { requireIngestAuth } from "./ingest-auth.js";
import { requireIntrospectionAuth } from "./introspection-auth.js";
import { ingestRouter } from "./routes/ingest.js";
import { keysIntrospectRouter } from "./routes/keys-introspect.js";
import { mountDashboard } from "./routes/dashboard.js";
import { mountObs } from "./routes/obs.js";
import { errorHandler } from "./http/error-handler.js";

export function buildApp(): Express {
  const app = express();

  // CORS_ORIGIN unset → same-origin only (the SPA is proxied through the same
  // host). Set to a CSV to allow specific cross-origin clients.
  const corsOrigins = (process.env["CORS_ORIGIN"] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  app.use(cors({ origin: corsOrigins.length ? corsOrigins : false, credentials: true }));

  // ── SERVICE — machine-to-machine, own guards, BEFORE the global json/cookie ──
  // Ingest takes a larger batch body; introspection is tiny. Both bypass the
  // dashboard's cookie auth and use their own bearer guards.
  app.use("/agentos/api/ingest", express.json({ limit: "5mb" }), requireIngestAuth, ingestRouter);
  app.use("/agentos/api/keys", express.json({ limit: "16kb" }), requireIntrospectionAuth, keysIntrospectRouter);

  app.use(express.json({ limit: "1mb" }));
  app.use(cookieParser());

  // ── DASHBOARD — versioned base. The SPA calls /api/v1/* (nginx maps
  // /api/ → /agentos/api/). Auth/health live inside, public, before the gate. ──
  app.use("/agentos/api/v1", mountDashboard());

  // ── OBSERVABILITY — /v1 (SPA obs client + external consumers) ──
  app.use("/v1", mountObs());

  app.use(errorHandler);
  return app;
}
