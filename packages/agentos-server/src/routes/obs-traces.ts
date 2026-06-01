// Observability — traces list, search, detail.
//
// Dispatches to ClickHouse or New Relic based on the TRACE_BACKEND env var.
// Both backends return the same JSON shape so the UI doesn't care.

import { Router, type Router as IRouter } from "express";
import { buildTraceListSql, buildNrqlTraceListQuery, type Filter, type Query } from "../query.js";
import { queryRows as chQueryRows } from "../clickhouse.js";
import { queryRows as nrqlQueryRows } from "../new-relic.js";
import { traceBackend } from "../trace-backend.js";

export const obsTracesRouter: IRouter = Router();

obsTracesRouter.get("/traces", async (req, res, next) => {
  try {
    const agent = typeof req.query["agent"] === "string" ? req.query["agent"] : undefined;
    const from = typeof req.query["from"] === "string" ? req.query["from"] : undefined;
    const to = typeof req.query["to"] === "string" ? req.query["to"] : undefined;
    const limit = req.query["limit"] ? parseInt(String(req.query["limit"]), 10) : 100;

    const filters: Filter[] = [];
    if (agent) filters.push({ field: "agent", op: "eq", value: agent });

    const q: Query = { filters, limit };
    if (from) q.from = from;
    if (to) q.to = to;

    const traces = await fetchTraceList(q);
    res.json({ traces });
  } catch (err) {
    next(err);
  }
});

obsTracesRouter.post("/traces/search", async (req, res, next) => {
  try {
    const q = (req.body ?? {}) as Query;
    const traces = await fetchTraceList(q);
    res.json({ traces });
  } catch (err) {
    next(err);
  }
});

type SpanRow = {
  TraceId: string;
  SpanId: string;
  ParentSpanId: string;
  SpanName: string;
  SpanKind: string;
  ServiceName: string;
  ts_ms: number;
  duration_ms: number;
  StatusCode: string;
  StatusMessage: string;
  ScopeName: string;
  SpanAttributes: Record<string, string>;
  ResourceAttributes: Record<string, string>;
};

obsTracesRouter.get("/traces/:traceId", async (req, res, next) => {
  try {
    const traceId = req.params["traceId"];
    if (!traceId || !/^[0-9a-fA-F]{16,64}$/.test(traceId)) {
      return res.status(400).json({ error: "invalid traceId" });
    }

    const spans = traceBackend() === "newrelic"
      ? await fetchTraceDetailNrql(traceId)
      : await fetchTraceDetailClickhouse(traceId);

    if (spans.length === 0) {
      return res.status(404).json({ error: "trace not found" });
    }
    const ids = new Set(spans.map((s) => s.SpanId));
    const root = spans.find((s) => !s.ParentSpanId || !ids.has(s.ParentSpanId)) ?? spans[0]!;
    res.json({ traceId, root, spans });
  } catch (err) {
    next(err);
  }
});

// ─── Backend dispatch ─────────────────────────────────────────────────────

async function fetchTraceList(q: Query): Promise<unknown[]> {
  if (traceBackend() === "newrelic") {
    const { nrql, params } = buildNrqlTraceListQuery(q);
    const rows = await nrqlQueryRows<Record<string, unknown>>(nrql, params);
    // NRQL FACET single-dim emits the value under the key `facet`. The UI
    // shape expects `TraceId`, so rename it here without touching anything
    // else on the row.
    return rows.map((r) => {
      const { facet, ...rest } = r;
      return { ...rest, TraceId: facet };
    });
  }
  const { sql, params } = buildTraceListSql(q);
  return chQueryRows(sql, params);
}

async function fetchTraceDetailClickhouse(traceId: string): Promise<SpanRow[]> {
  const sql = `
    SELECT
      TraceId,
      SpanId,
      ParentSpanId,
      SpanName,
      SpanKind,
      ServiceName,
      toUnixTimestamp64Milli(Timestamp) AS ts_ms,
      (Duration / 1e6) AS duration_ms,
      StatusCode,
      StatusMessage,
      ScopeName,
      SpanAttributes,
      ResourceAttributes
    FROM otel_traces
    WHERE TraceId = {tid:String}
    ORDER BY Timestamp ASC
  `;
  return chQueryRows<SpanRow>(sql, { tid: traceId });
}

/**
 * NRQL doesn't surface span attributes as a single `SpanAttributes` map — they
 * are flattened onto the Span event. We `SELECT *` for the trace ID, then
 * re-bundle attributes client-side to match the ClickHouse shape the UI expects.
 *
 * NRQL has a hard limit (default 2000) on rows per query. Traces with more than
 * 2000 spans get truncated; this matches ClickHouse's pragmatic behavior.
 */
async function fetchTraceDetailNrql(traceId: string): Promise<SpanRow[]> {
  type NrqlSpan = Record<string, unknown> & {
    "trace.id"?: string;
    id?: string;
    "parent.id"?: string;
    name?: string;
    "span.kind"?: string;
    "service.name"?: string;
    timestamp?: number;
    "duration.ms"?: number;
    "otel.status_code"?: string;
    "otel.status_description"?: string;
    "instrumentation.name"?: string;
  };

  const rows = await nrqlQueryRows<NrqlSpan>(
    `SELECT * FROM Span WHERE trace.id = {tid:String} LIMIT 2000`,
    { tid: traceId },
  );

  const FRAME_KEYS = new Set([
    "trace.id",
    "id",
    "parent.id",
    "name",
    "span.kind",
    "service.name",
    "timestamp",
    "duration.ms",
    "otel.status_code",
    "otel.status_description",
    "instrumentation.name",
  ]);

  return rows
    .map((row): SpanRow => {
      const spanAttributes: Record<string, string> = {};
      const resourceAttributes: Record<string, string> = {};
      for (const [k, v] of Object.entries(row)) {
        if (FRAME_KEYS.has(k)) continue;
        const sv = v == null ? "" : String(v);
        // Heuristic: `service.*`, `host.*`, `cloud.*`, `k8s.*` are resource-level.
        if (/^(service|host|cloud|k8s|container|process|telemetry)\./.test(k)) {
          resourceAttributes[k] = sv;
        } else {
          spanAttributes[k] = sv;
        }
      }
      return {
        TraceId: String(row["trace.id"] ?? traceId),
        SpanId: String(row["id"] ?? ""),
        ParentSpanId: String(row["parent.id"] ?? ""),
        SpanName: String(row["name"] ?? ""),
        SpanKind: String(row["span.kind"] ?? ""),
        ServiceName: String(row["service.name"] ?? ""),
        ts_ms: Number(row["timestamp"] ?? 0),
        duration_ms: Number(row["duration.ms"] ?? 0),
        StatusCode: String(row["otel.status_code"] ?? ""),
        StatusMessage: String(row["otel.status_description"] ?? ""),
        ScopeName: String(row["instrumentation.name"] ?? ""),
        SpanAttributes: spanAttributes,
        ResourceAttributes: resourceAttributes,
      };
    })
    .sort((a, b) => a.ts_ms - b.ts_ms);
}
