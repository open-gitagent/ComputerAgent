// Combined server: AgentOS dashboard API + observability read API.
//
// Surface:
//   /agentos/api/login, /logout, /me   — PUBLIC (auth.ts)
//   /agentos/api/health                — PUBLIC
//   /v1/health                         — PUBLIC
//   /agentos/api/*                     — GATED (cookie OR Basic)
//   /v1/*                              — GATED (cookie OR Basic)
//
// Talks to:
//   - ComputerAgent harness (CA_BASE) for sandbox/run/artifact
//   - MongoDB / DocumentDB (MONGO_URL) for registry, threads, sessions, logs,
//     schedules
//   - Trace store, selected by TRACE_BACKEND env var:
//       - "clickhouse" (default) → CLICKHOUSE_URL
//       - "newrelic"             → NerdGraph (NEW_RELIC_USER_API_KEY +
//                                  NEW_RELIC_ACCOUNT_ID + NEW_RELIC_REGION)
//
// Hostable as one Docker container; harness stays on the host (substrate
// isolation needs root-ish privileges).

// MUST be the first import — loads .env files before anything reads process.env.
import "./load-env.js";

import express, { type ErrorRequestHandler } from "express";
import cookieParser from "cookie-parser";
import cors from "cors";

import { requireAuth } from "./auth.js";
import { requireIngestAuth } from "./ingest-auth.js";
import { authRouter } from "./routes/auth.js";
import { healthRouter } from "./routes/health.js";
import { ingestRouter } from "./routes/ingest.js";
import { agentsRouter } from "./routes/agents.js";
import { logsRouter } from "./routes/logs.js";
import { sessionsRouter } from "./routes/sessions.js";
import { schedulesRouter } from "./routes/schedules.js";
import { chatRouter } from "./routes/chat.js";
import { runRouter } from "./routes/run.js";
import { completionRouter } from "./routes/completion.js";
import { policiesRouter } from "./routes/policies.js";
import { obsTracesRouter } from "./routes/obs-traces.js";
import { obsDashboardRouter } from "./routes/obs-dashboard.js";
import { obsFieldsRouter } from "./routes/obs-fields.js";

import { pingClickHouse } from "./clickhouse.js";
import { pingNewRelic } from "./new-relic.js";
import { pingMongo, migrateLegacyWebSessions } from "./mongo.js";
import { ensureFieldValueMVs } from "./migrations.js";
import { startScheduler } from "./scheduler.js";
import { seedDefaultAgentIfRequested } from "./agent-defs.js";
import { traceBackend } from "./trace-backend.js";

const app = express();

// CORS_ORIGIN unset → same-origin only (the SPA is proxied through the same
// host in dev and prod). Set to a CSV to allow specific cross-origin clients.
const corsOrigins = (process.env["CORS_ORIGIN"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
app.use(cors({
  origin: corsOrigins.length ? corsOrigins : false,
  credentials: true,
}));
// Telemetry ingest — mounted BEFORE the 1mb global JSON parser so it can take
// a larger batch body, and before requireAuth so the headless SDK uses its own
// bearer-token guard instead of the dashboard's cookie/Basic auth.
app.use(
  "/agentos/api/ingest",
  express.json({ limit: "5mb" }),
  requireIngestAuth,
  ingestRouter,
);

app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());

// PUBLIC — health + auth. Mounted at /agentos/api/* AND /v1/health for
// drop-in compatibility with anything that used to hit obs-api directly.
app.use("/agentos/api", authRouter);
app.use("/agentos/api", healthRouter);
app.use("/v1", healthRouter);

// EVERYTHING ELSE — gate behind requireAuth.
app.use("/agentos/api", requireAuth);
app.use("/v1", requireAuth);

// Dashboard surface
app.use("/agentos/api", agentsRouter);    // /agents, /agents/by-source, /agents/register, PATCH/DELETE
app.use("/agentos/api", logsRouter);      // /logs (GET/POST)
app.use("/agentos/api", sessionsRouter);  // /sessions, /sessions/:id
app.use("/agentos/api", schedulesRouter); // /schedules CRUD + /:id/run-now
app.use("/agentos/api", chatRouter);      // /agents/:name/chat-sandbox, sandbox SSE proxy, artifact
app.use("/agentos/api", runRouter);       // /agents/:name/run (one-shot SSE)
app.use("/agentos/api", completionRouter); // /completion (agent-less Claude chat SSE)
app.use("/agentos/api", policiesRouter);  // /policies, /opa-policies (stubs)

// Observability surface
app.use("/v1", obsTracesRouter);          // /traces (search before list, list before :id)
app.use("/v1", obsDashboardRouter);       // /dashboard
app.use("/v1", obsFieldsRouter);          // /fields, /fields/:name/values

const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  const status = typeof err?.status === "number" ? err.status : 500;
  const message = typeof err?.message === "string" ? err.message : "internal error";
  if (status >= 500) console.error("[agentos-server]", err);
  res.status(status).json({ error: typeof err?.code === "string" ? { code: err.code, message } : message });
};
app.use(errorHandler);

// Use AGENTOS_PORT (not PORT) so the harness and this server can coexist in
// one .env file — the harness uses PORT for its own listener.
const PORT = parseInt(process.env["AGENTOS_PORT"] ?? "8788", 10);
app.listen(PORT, async () => {
  console.log(`[agentos-server] listening on http://localhost:${PORT}`);
  console.log(`[agentos-server] CA_BASE=${process.env["CA_BASE"] ?? "http://127.0.0.1:8787"}`);

  // The telemetry ingest route bypasses the dashboard's cookie/Basic auth and
  // mutates dashboard-visible data (registry/logs/sessions). When its token is
  // unset it is fully open — fine behind a network policy / on loopback, but a
  // sharp edge on an exposed pod. Warn loudly so it's a deliberate choice.
  if (!process.env["AGENTOS_INGEST_TOKEN"]) {
    console.warn(
      "[agentos-server] WARNING: AGENTOS_INGEST_TOKEN unset — POST /agentos/api/ingest/events is OPEN " +
        "(anonymous writes to agent_registry/agent_logs/sessions/agent_messages). " +
        "Set AGENTOS_INGEST_TOKEN on any network-exposed deployment.",
    );
  }

  const backend = traceBackend();
  console.log(`[agentos-server] trace backend: ${backend}`);

  // Ping the active trace backend in parallel with Mongo. The OTHER backend
  // can still be reachable during dual-export, but we only block on the one
  // routes actually call.
  const traceProbe = backend === "newrelic" ? pingNewRelic() : pingClickHouse();
  const [mongoOk, traceOk] = await Promise.all([pingMongo(), traceProbe]);
  console.log(`[agentos-server] mongo: ${mongoOk ? "up" : "DOWN (check MONGO_URL)"}`);
  console.log(
    `[agentos-server] ${backend}: ${traceOk ? "up" : `DOWN (check ${backend === "newrelic" ? "NEW_RELIC_USER_API_KEY/ACCOUNT_ID" : "CLICKHOUSE_URL"})`}`,
  );

  // ClickHouse MVs — only relevant when TRACE_BACKEND=clickhouse. Best-effort.
  if (backend === "clickhouse" && traceOk) {
    try {
      const result = await ensureFieldValueMVs();
      if (result.status === "skipped") {
        console.warn(`[agentos-server] obs MV bootstrap skipped: ${result.reason}`);
      } else if (result.status === "created-and-backfilled") {
        console.log("[agentos-server] obs MVs created + backfilled");
      } else {
        console.log("[agentos-server] obs MVs ready");
      }
    } catch (err) {
      console.warn("[agentos-server] obs MV bootstrap failed:", (err as Error).message);
    }
  }

  // Mongo-side bootstrap — seed default agent and start the scheduler tick.
  if (mongoOk) {
    try {
      await seedDefaultAgentIfRequested();
    } catch (err) {
      console.warn("[agentos-server] seed failed:", (err as Error).message);
    }
    // One-time, idempotent: migrate legacy web chat rows out of slack_threads
    // into the dedicated chat_sessions collection so existing sessions keep
    // showing after the decoupling.
    try {
      const n = await migrateLegacyWebSessions();
      if (n > 0) console.log(`[agentos-server] backfilled ${n} web session(s) into chat_sessions`);
    } catch (err) {
      console.warn("[agentos-server] chat_sessions backfill failed:", (err as Error).message);
    }
    startScheduler();
  }
});
