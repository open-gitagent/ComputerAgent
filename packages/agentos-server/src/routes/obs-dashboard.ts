// Observability dashboard aggregate. Ported verbatim from
// packages/observability-api/src/routes/dashboard.ts.

import { Router, type Router as IRouter } from "express";
import { queryOne, queryRows } from "../clickhouse.js";
import { parseTime, toClickHouseDateTime } from "../time.js";

export const obsDashboardRouter: IRouter = Router();

obsDashboardRouter.get("/dashboard", async (req, res, next) => {
  try {
    const from = typeof req.query["from"] === "string" ? req.query["from"] : "now-24h";
    const to = typeof req.query["to"] === "string" ? req.query["to"] : "now";
    const agent = typeof req.query["agent"] === "string" ? req.query["agent"] : undefined;

    const fromDate = parseTime(from);
    const toDate = parseTime(to);
    const params: Record<string, unknown> = {
      t_from: toClickHouseDateTime(fromDate),
      t_to: toClickHouseDateTime(toDate),
    };
    let agentClause = "";
    if (agent) {
      params["agent"] = agent;
      agentClause = "AND SpanAttributes['gen_ai.agent.name'] = {agent:String}";
    }
    const whereBase = `Timestamp >= parseDateTime64BestEffort({t_from:String}, 9)
      AND Timestamp < parseDateTime64BestEffort({t_to:String}, 9)
      ${agentClause}`;

    const deltaSec = Math.max(60, (toDate.getTime() - fromDate.getTime()) / 1000);
    const intervalSec = Math.max(60, Math.round(deltaSec / 60));

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
      queryOne<{ total: number }>(
        `SELECT sum(toFloat64OrZero(SpanAttributes['computeragent.usage.cost_usd'])) AS total
         FROM otel_traces WHERE ${whereBase}`,
        params,
      ),
      queryRows<{ model: string; cost: number }>(
        `SELECT SpanAttributes['gen_ai.request.model'] AS model,
                sum(toFloat64OrZero(SpanAttributes['computeragent.usage.cost_usd'])) AS cost
         FROM otel_traces
         WHERE ${whereBase} AND SpanAttributes['gen_ai.request.model'] != ''
         GROUP BY model ORDER BY cost DESC LIMIT 10`,
        params,
      ),
      queryOne<{ in_tokens: number; out_tokens: number }>(
        `SELECT sum(toUInt32OrZero(SpanAttributes['gen_ai.usage.input_tokens']))  AS in_tokens,
                sum(toUInt32OrZero(SpanAttributes['gen_ai.usage.output_tokens'])) AS out_tokens
         FROM otel_traces WHERE ${whereBase}`,
        params,
      ),
      queryRows<{ model: string; in_tokens: number; out_tokens: number }>(
        `SELECT SpanAttributes['gen_ai.request.model'] AS model,
                sum(toUInt32OrZero(SpanAttributes['gen_ai.usage.input_tokens']))  AS in_tokens,
                sum(toUInt32OrZero(SpanAttributes['gen_ai.usage.output_tokens'])) AS out_tokens
         FROM otel_traces
         WHERE ${whereBase} AND SpanAttributes['gen_ai.request.model'] != ''
         GROUP BY model ORDER BY (in_tokens + out_tokens) DESC LIMIT 10`,
        params,
      ),
      queryOne<{ p50: number; p95: number; p99: number; count: number }>(
        `SELECT quantile(0.5)(Duration / 1e6)  AS p50,
                quantile(0.95)(Duration / 1e6) AS p95,
                quantile(0.99)(Duration / 1e6) AS p99,
                count() AS count
         FROM otel_traces WHERE ${whereBase}`,
        params,
      ),
      queryRows<{ operation: string; p50: number; p95: number; count: number }>(
        `SELECT SpanAttributes['gen_ai.operation.name'] AS operation,
                quantile(0.5)(Duration / 1e6)  AS p50,
                quantile(0.95)(Duration / 1e6) AS p95,
                count() AS count
         FROM otel_traces
         WHERE ${whereBase} AND SpanAttributes['gen_ai.operation.name'] != ''
         GROUP BY operation ORDER BY count DESC`,
        params,
      ),
      queryOne<{ errors: number; total: number }>(
        `SELECT countIf(StatusCode IN ('Error','STATUS_CODE_ERROR')) AS errors,
                count() AS total
         FROM otel_traces WHERE ${whereBase}`,
        params,
      ),
      queryRows<{ t: string; count: number }>(
        `SELECT formatDateTime(toStartOfMinute(Timestamp), '%Y-%m-%dT%H:%i:%SZ') AS t,
                count() AS count
         FROM otel_traces WHERE ${whereBase}
         GROUP BY t ORDER BY t ASC`,
        params,
      ),
      queryRows<{ bucket: string; sort_key: number; count: number }>(
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
      queryRows<{
        t: string;
        spans: number;
        cost: number;
        input_tokens: number;
        output_tokens: number;
        p95_ms: number;
        errors: number;
      }>(
        `SELECT
           formatDateTime(toStartOfInterval(Timestamp, INTERVAL ${intervalSec} SECOND), '%Y-%m-%dT%H:%i:%SZ') AS t,
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

    res.json({
      intervalSec,
      window: { from, to },
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
      throughput: {
        bucketed: throughput.map((r) => ({ t: r.t, count: Number(r.count) })),
      },
      latencyHistogram: latencyHistogram.map((r) => ({
        bucket: r.bucket,
        count: Number(r.count),
      })),
      trends: trends.map((r) => ({
        t: r.t,
        spans: Number(r.spans),
        cost: Number(r.cost),
        inputTokens: Number(r.input_tokens),
        outputTokens: Number(r.output_tokens),
        p95Ms: Number(r.p95_ms),
        errors: Number(r.errors),
      })),
    });
  } catch (err) {
    next(err);
  }
});
