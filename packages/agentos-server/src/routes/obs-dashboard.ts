// Observability dashboard aggregate.
//
// Dispatches to ClickHouse or NRQL based on TRACE_BACKEND. Returns the same
// JSON shape from both backends so the UI dashboard renders identically.

import { Router, type Router as IRouter } from "express";
import { queryOne as chQueryOne, queryRows as chQueryRows } from "../clickhouse.js";
import { queryOne as nrqlQueryOne, queryRows as nrqlQueryRows } from "../new-relic.js";
import { parseTime, toClickHouseDateTime } from "../time.js";
import { traceBackend } from "../trace-backend.js";

export const obsDashboardRouter: IRouter = Router();

interface DashboardResponse {
  intervalSec: number;
  window: { from: string; to: string };
  cost: { total: number; byModel: Array<{ model: string; cost: number }> };
  tokens: {
    input: number;
    output: number;
    byModel: Array<{ model: string; input: number; output: number }>;
  };
  latency: {
    p50: number;
    p95: number;
    p99: number;
    count: number;
    byOperation: Array<{ operation: string; p50: number; p95: number; count: number }>;
  };
  errors: { total: number; rate: number; sampleSize: number };
  throughput: { bucketed: Array<{ t: string; count: number }> };
  latencyHistogram: Array<{ bucket: string; count: number }>;
  trends: Array<{
    t: string;
    spans: number;
    cost: number;
    inputTokens: number;
    outputTokens: number;
    p95Ms: number;
    errors: number;
  }>;
}

obsDashboardRouter.get("/dashboard", async (req, res, next) => {
  try {
    const from = typeof req.query["from"] === "string" ? req.query["from"] : "now-24h";
    const to = typeof req.query["to"] === "string" ? req.query["to"] : "now";
    const agent = typeof req.query["agent"] === "string" ? req.query["agent"] : undefined;

    const fromDate = parseTime(from);
    const toDate = parseTime(to);
    const deltaSec = Math.max(60, (toDate.getTime() - fromDate.getTime()) / 1000);
    const intervalSec = Math.max(60, Math.round(deltaSec / 60));

    const payload = traceBackend() === "newrelic"
      ? await dashboardFromNrql({ fromDate, toDate, intervalSec, agent })
      : await dashboardFromClickhouse({ fromDate, toDate, intervalSec, agent });

    res.json({ intervalSec, window: { from, to }, ...payload });
  } catch (err) {
    next(err);
  }
});

// ─── ClickHouse dashboard (unchanged behavior) ────────────────────────────

async function dashboardFromClickhouse(opts: {
  fromDate: Date;
  toDate: Date;
  intervalSec: number;
  agent?: string;
}): Promise<Omit<DashboardResponse, "intervalSec" | "window">> {
  const params: Record<string, unknown> = {
    t_from: toClickHouseDateTime(opts.fromDate),
    t_to: toClickHouseDateTime(opts.toDate),
  };
  let agentClause = "";
  if (opts.agent) {
    params["agent"] = opts.agent;
    agentClause = "AND SpanAttributes['gen_ai.agent.name'] = {agent:String}";
  }
  const whereBase = `Timestamp >= parseDateTime64BestEffort({t_from:String}, 9)
    AND Timestamp < parseDateTime64BestEffort({t_to:String}, 9)
    ${agentClause}`;

  const [
    costTotal,
    costByModel,
    tokenTotal,
    tokensByModel,
    latency,
    latencyByOp,
    errors,
    throughput,
    latencyHistogram,
    trends,
  ] = await Promise.all([
    chQueryOne<{ total: number }>(
      `SELECT sum(toFloat64OrZero(SpanAttributes['computeragent.usage.cost_usd'])) AS total
       FROM otel_traces WHERE ${whereBase}`,
      params,
    ),
    chQueryRows<{ model: string; cost: number }>(
      `SELECT SpanAttributes['gen_ai.request.model'] AS model,
              sum(toFloat64OrZero(SpanAttributes['computeragent.usage.cost_usd'])) AS cost
       FROM otel_traces
       WHERE ${whereBase} AND SpanAttributes['gen_ai.request.model'] != ''
       GROUP BY model ORDER BY cost DESC LIMIT 10`,
      params,
    ),
    chQueryOne<{ in_tokens: number; out_tokens: number }>(
      `SELECT sum(toUInt32OrZero(SpanAttributes['gen_ai.usage.input_tokens']))  AS in_tokens,
              sum(toUInt32OrZero(SpanAttributes['gen_ai.usage.output_tokens'])) AS out_tokens
       FROM otel_traces WHERE ${whereBase}`,
      params,
    ),
    chQueryRows<{ model: string; in_tokens: number; out_tokens: number }>(
      `SELECT SpanAttributes['gen_ai.request.model'] AS model,
              sum(toUInt32OrZero(SpanAttributes['gen_ai.usage.input_tokens']))  AS in_tokens,
              sum(toUInt32OrZero(SpanAttributes['gen_ai.usage.output_tokens'])) AS out_tokens
       FROM otel_traces
       WHERE ${whereBase} AND SpanAttributes['gen_ai.request.model'] != ''
       GROUP BY model ORDER BY (in_tokens + out_tokens) DESC LIMIT 10`,
      params,
    ),
    chQueryOne<{ p50: number; p95: number; p99: number; count: number }>(
      `SELECT quantile(0.5)(Duration / 1e6)  AS p50,
              quantile(0.95)(Duration / 1e6) AS p95,
              quantile(0.99)(Duration / 1e6) AS p99,
              count() AS count
       FROM otel_traces WHERE ${whereBase}`,
      params,
    ),
    chQueryRows<{ operation: string; p50: number; p95: number; count: number }>(
      `SELECT SpanAttributes['gen_ai.operation.name'] AS operation,
              quantile(0.5)(Duration / 1e6)  AS p50,
              quantile(0.95)(Duration / 1e6) AS p95,
              count() AS count
       FROM otel_traces
       WHERE ${whereBase} AND SpanAttributes['gen_ai.operation.name'] != ''
       GROUP BY operation ORDER BY count DESC`,
      params,
    ),
    chQueryOne<{ errors: number; total: number }>(
      `SELECT countIf(StatusCode IN ('Error','STATUS_CODE_ERROR')) AS errors,
              count() AS total
       FROM otel_traces WHERE ${whereBase}`,
      params,
    ),
    chQueryRows<{ t: string; count: number }>(
      `SELECT formatDateTime(toStartOfMinute(Timestamp), '%Y-%m-%dT%H:%i:%SZ') AS t,
              count() AS count
       FROM otel_traces WHERE ${whereBase}
       GROUP BY t ORDER BY t ASC`,
      params,
    ),
    chQueryRows<{ bucket: string; sort_key: number; count: number }>(
      `SELECT
         multiIf(
           Duration < 10000000,         '<10ms',
           Duration < 50000000,         '10-50ms',
           Duration < 100000000,        '50-100ms',
           Duration < 500000000,        '100-500ms',
           Duration < 1000000000,       '500ms-1s',
           Duration < 5000000000,       '1-5s',
           Duration < 10000000000,      '5-10s',
           Duration < 30000000000,      '10-30s',
                                        '>30s'
         ) AS bucket,
         multiIf(
           Duration < 10000000,         0,
           Duration < 50000000,         1,
           Duration < 100000000,        2,
           Duration < 500000000,        3,
           Duration < 1000000000,       4,
           Duration < 5000000000,       5,
           Duration < 10000000000,      6,
           Duration < 30000000000,      7,
                                        8
         ) AS sort_key,
         count() AS count
       FROM otel_traces WHERE ${whereBase}
       GROUP BY bucket, sort_key
       ORDER BY sort_key ASC`,
      params,
    ),
    chQueryRows<{
      t: string;
      spans: number;
      cost: number;
      input_tokens: number;
      output_tokens: number;
      p95_ms: number;
      errors: number;
    }>(
      `SELECT
         formatDateTime(toStartOfInterval(Timestamp, INTERVAL ${opts.intervalSec} SECOND), '%Y-%m-%dT%H:%i:%SZ') AS t,
         count() AS spans,
         sum(toFloat64OrZero(SpanAttributes['computeragent.usage.cost_usd'])) AS cost,
         sum(toUInt32OrZero(SpanAttributes['gen_ai.usage.input_tokens']))     AS input_tokens,
         sum(toUInt32OrZero(SpanAttributes['gen_ai.usage.output_tokens']))    AS output_tokens,
         quantile(0.95)(Duration / 1e6)                                       AS p95_ms,
         countIf(StatusCode IN ('Error','STATUS_CODE_ERROR'))                 AS errors
       FROM otel_traces WHERE ${whereBase}
       GROUP BY t ORDER BY t ASC`,
      params,
    ),
  ]);

  return {
    cost: {
      total: Number(costTotal?.total ?? 0),
      byModel: costByModel.map((r) => ({ model: r.model, cost: Number(r.cost) })),
    },
    tokens: {
      input: Number(tokenTotal?.in_tokens ?? 0),
      output: Number(tokenTotal?.out_tokens ?? 0),
      byModel: tokensByModel.map((r) => ({
        model: r.model,
        input: Number(r.in_tokens),
        output: Number(r.out_tokens),
      })),
    },
    latency: {
      p50: Number(latency?.p50 ?? 0),
      p95: Number(latency?.p95 ?? 0),
      p99: Number(latency?.p99 ?? 0),
      count: Number(latency?.count ?? 0),
      byOperation: latencyByOp.map((r) => ({
        operation: r.operation,
        p50: Number(r.p50),
        p95: Number(r.p95),
        count: Number(r.count),
      })),
    },
    errors: {
      total: Number(errors?.errors ?? 0),
      rate: errors && Number(errors.total) > 0 ? Number(errors.errors) / Number(errors.total) : 0,
      sampleSize: Number(errors?.total ?? 0),
    },
    throughput: { bucketed: throughput.map((r) => ({ t: r.t, count: Number(r.count) })) },
    latencyHistogram: latencyHistogram.map((r) => ({ bucket: r.bucket, count: Number(r.count) })),
    trends: trends.map((r) => ({
      t: r.t,
      spans: Number(r.spans),
      cost: Number(r.cost),
      inputTokens: Number(r.input_tokens),
      outputTokens: Number(r.output_tokens),
      p95Ms: Number(r.p95_ms),
      errors: Number(r.errors),
    })),
  };
}

// ─── NRQL dashboard ───────────────────────────────────────────────────────

async function dashboardFromNrql(opts: {
  fromDate: Date;
  toDate: Date;
  intervalSec: number;
  agent?: string;
}): Promise<Omit<DashboardResponse, "intervalSec" | "window">> {
  const params: Record<string, unknown> = {
    t_from: opts.fromDate,
    t_to: opts.toDate,
  };
  let agentClause = "";
  if (opts.agent) {
    params["agent"] = opts.agent;
    agentClause = " AND `gen_ai.agent.name` = {agent:String}";
  }
  const baseWhere = `WHERE 1=1${agentClause}`;
  const sinceUntil = `SINCE {t_from:Timestamp} UNTIL {t_to:Timestamp}`;

  const [
    costTotal,
    costByModel,
    tokenTotal,
    tokensByModel,
    latency,
    latencyByOp,
    errors,
    throughput,
    latencyHistogram,
    trends,
  ] = await Promise.all([
    nrqlQueryOne<{ total: number }>(
      `SELECT sum(\`computeragent.usage.cost_usd\`) AS total FROM Span ${baseWhere} ${sinceUntil}`,
      params,
    ),
    nrqlQueryRows<{ facet: string; cost: number }>(
      // NRQL: single-dim FACET auto-names its column `facet` in the results;
      // adding `AS facet` is a syntax error (NRQL doesn't allow aliasing the
      // FACET attribute).
      `SELECT sum(\`computeragent.usage.cost_usd\`) AS cost
       FROM Span ${baseWhere} AND \`gen_ai.request.model\` IS NOT NULL
       FACET \`gen_ai.request.model\`
       ${sinceUntil}
       LIMIT 10`,
      params,
    ),
    nrqlQueryOne<{ in_tokens: number; out_tokens: number }>(
      `SELECT sum(\`gen_ai.usage.input_tokens\`)  AS in_tokens,
              sum(\`gen_ai.usage.output_tokens\`) AS out_tokens
       FROM Span ${baseWhere} ${sinceUntil}`,
      params,
    ),
    nrqlQueryRows<{ facet: string; in_tokens: number; out_tokens: number }>(
      `SELECT sum(\`gen_ai.usage.input_tokens\`)  AS in_tokens,
              sum(\`gen_ai.usage.output_tokens\`) AS out_tokens
       FROM Span ${baseWhere} AND \`gen_ai.request.model\` IS NOT NULL
       FACET \`gen_ai.request.model\`
       ${sinceUntil}
       LIMIT 10`,
      params,
    ),
    nrqlQueryOne<{ p50: number; p95: number; p99: number; count: number }>(
      `SELECT percentile(duration.ms, 50) AS p50,
              percentile(duration.ms, 95) AS p95,
              percentile(duration.ms, 99) AS p99,
              count(*) AS count
       FROM Span ${baseWhere} ${sinceUntil}`,
      params,
    ),
    nrqlQueryRows<{ facet: string; p50: number; p95: number; count: number }>(
      `SELECT percentile(duration.ms, 50) AS p50,
              percentile(duration.ms, 95) AS p95,
              count(*) AS count
       FROM Span ${baseWhere} AND \`gen_ai.operation.name\` IS NOT NULL
       FACET \`gen_ai.operation.name\`
       ${sinceUntil}`,
      params,
    ),
    nrqlQueryOne<{ errors: number; total: number }>(
      `SELECT filter(count(*), WHERE otel.status_code IN ('Error','STATUS_CODE_ERROR')) AS errors,
              count(*) AS total
       FROM Span ${baseWhere} ${sinceUntil}`,
      params,
    ),
    nrqlQueryRows<{ beginTimeSeconds?: number; count: number }>(
      // TIMESERIES returns rows with `beginTimeSeconds` (numeric epoch) + the metric.
      // We translate that to the ISO string the UI expects.
      `SELECT count(*) AS count
       FROM Span ${baseWhere} ${sinceUntil}
       TIMESERIES 60 seconds`,
      params,
    ),
    nrqlQueryRows<{ facet: string; count: number }>(
      // NRQL has no `multiIf` — emulate with `CASES`/`filter()`. We FACET on a
      // labeled bucket computed via a chain of `WHERE` ranges. NRQL supports
      // arbitrary CASE expressions on the SELECT side; we use `filter()` per
      // bucket so the result has one row per bucket.
      //
      // The `bucket` order is preserved by the explicit row order in the SELECT.
      `SELECT
         filter(count(*), WHERE duration.ms < 10)            AS \`<10ms\`,
         filter(count(*), WHERE duration.ms >= 10 AND duration.ms < 50)         AS \`10-50ms\`,
         filter(count(*), WHERE duration.ms >= 50 AND duration.ms < 100)        AS \`50-100ms\`,
         filter(count(*), WHERE duration.ms >= 100 AND duration.ms < 500)       AS \`100-500ms\`,
         filter(count(*), WHERE duration.ms >= 500 AND duration.ms < 1000)      AS \`500ms-1s\`,
         filter(count(*), WHERE duration.ms >= 1000 AND duration.ms < 5000)     AS \`1-5s\`,
         filter(count(*), WHERE duration.ms >= 5000 AND duration.ms < 10000)    AS \`5-10s\`,
         filter(count(*), WHERE duration.ms >= 10000 AND duration.ms < 30000)   AS \`10-30s\`,
         filter(count(*), WHERE duration.ms >= 30000)                           AS \`>30s\`
       FROM Span ${baseWhere} ${sinceUntil}`,
      params,
    ),
    nrqlQueryRows<{
      beginTimeSeconds?: number;
      spans: number;
      cost: number;
      input_tokens: number;
      output_tokens: number;
      p95_ms: number;
      errors: number;
    }>(
      `SELECT count(*) AS spans,
              sum(\`computeragent.usage.cost_usd\`) AS cost,
              sum(\`gen_ai.usage.input_tokens\`)  AS input_tokens,
              sum(\`gen_ai.usage.output_tokens\`) AS output_tokens,
              percentile(duration.ms, 95) AS p95_ms,
              filter(count(*), WHERE otel.status_code IN ('Error','STATUS_CODE_ERROR')) AS errors
       FROM Span ${baseWhere} ${sinceUntil}
       TIMESERIES ${opts.intervalSec} seconds`,
      params,
    ),
  ]);

  // The histogram query returns ONE row keyed by bucket-name columns. Expand
  // into the same `{bucket, count}[]` shape the ClickHouse handler returned.
  const HIST_BUCKETS = ["<10ms", "10-50ms", "50-100ms", "100-500ms", "500ms-1s", "1-5s", "5-10s", "10-30s", ">30s"];
  const histRow = (latencyHistogram[0] ?? {}) as Record<string, unknown>;
  const histogram = HIST_BUCKETS.map((bucket) => ({
    bucket,
    count: Number(histRow[bucket] ?? 0),
  }));

  return {
    cost: {
      total: Number(costTotal?.total ?? 0),
      byModel: costByModel.map((r) => ({ model: r.facet, cost: Number(r.cost) })),
    },
    tokens: {
      input: Number(tokenTotal?.in_tokens ?? 0),
      output: Number(tokenTotal?.out_tokens ?? 0),
      byModel: tokensByModel.map((r) => ({
        model: r.facet,
        input: Number(r.in_tokens),
        output: Number(r.out_tokens),
      })),
    },
    latency: {
      p50: Number(latency?.p50 ?? 0),
      p95: Number(latency?.p95 ?? 0),
      p99: Number(latency?.p99 ?? 0),
      count: Number(latency?.count ?? 0),
      byOperation: latencyByOp.map((r) => ({
        operation: r.facet,
        p50: Number(r.p50),
        p95: Number(r.p95),
        count: Number(r.count),
      })),
    },
    errors: {
      total: Number(errors?.errors ?? 0),
      rate: errors && Number(errors.total) > 0 ? Number(errors.errors) / Number(errors.total) : 0,
      sampleSize: Number(errors?.total ?? 0),
    },
    throughput: {
      bucketed: throughput.map((r) => ({
        t: toIso(r.beginTimeSeconds),
        count: Number(r.count),
      })),
    },
    latencyHistogram: histogram,
    trends: trends.map((r) => ({
      t: toIso(r.beginTimeSeconds),
      spans: Number(r.spans),
      cost: Number(r.cost),
      inputTokens: Number(r.input_tokens),
      outputTokens: Number(r.output_tokens),
      p95Ms: Number(r.p95_ms),
      errors: Number(r.errors),
    })),
  };
}

function toIso(beginTimeSeconds: number | undefined): string {
  if (typeof beginTimeSeconds !== "number" || !Number.isFinite(beginTimeSeconds)) return "";
  return new Date(beginTimeSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}
