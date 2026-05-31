import express, { type ErrorRequestHandler } from "express";
import cors from "cors";

import { healthRouter } from "./routes/health.js";
import { tracesListRouter } from "./routes/traces-list.js";
import { tracesSearchRouter } from "./routes/traces-search.js";
import { traceDetailRouter } from "./routes/traces-detail.js";
import { dashboardRouter } from "./routes/dashboard.js";
import { fieldValuesRouter } from "./routes/field-values.js";
import { fieldsRouter } from "./routes/fields.js";
import { pingClickHouse } from "./clickhouse.js";
import { ensureFieldValueMVs } from "./migrations.js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.use("/v1", healthRouter);
app.use("/v1", fieldsRouter);
app.use("/v1", fieldValuesRouter);
app.use("/v1", tracesSearchRouter);   // POST /v1/traces/search  (before /traces/:id)
app.use("/v1", tracesListRouter);     // GET  /v1/traces
app.use("/v1", traceDetailRouter);    // GET  /v1/traces/:traceId
app.use("/v1", dashboardRouter);      // GET  /v1/dashboard

const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  const status = typeof err?.status === "number" ? err.status : 500;
  const message = typeof err?.message === "string" ? err.message : "internal error";
  if (status >= 500) console.error("[obs-api]", err);
  res.status(status).json({ error: message });
};
app.use(errorHandler);

const PORT = parseInt(process.env["PORT"] ?? "7801", 10);
app.listen(PORT, async () => {
  console.log(`[obs-api] listening on http://localhost:${PORT}`);

  const ok = await pingClickHouse();
  console.log(`[obs-api] clickhouse: ${ok ? "up" : "DOWN (check CLICKHOUSE_URL)"}`);
  if (!ok) return;

  // Best-effort: create the field-value materialized views if missing.
  // Never crashes startup — autocomplete falls back to DISTINCT scan when
  // MVs aren't present.
  try {
    const result = await ensureFieldValueMVs();
    if (result.status === "skipped") {
      console.warn(`[obs-api] MV bootstrap skipped: ${result.reason}`);
    } else if (result.status === "created-and-backfilled") {
      console.log("[obs-api] field-value MVs created + backfilled from otel_traces");
    } else {
      console.log("[obs-api] field-value MVs ready");
    }
  } catch (err) {
    console.warn("[obs-api] field-value MV bootstrap failed:", (err as Error).message);
    console.warn("[obs-api] autocomplete will use the SELECT DISTINCT fallback");
  }
});
