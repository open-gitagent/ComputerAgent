// Observability — traces list, search, detail. Ported from
// packages/observability-api/src/routes/{traces-list,traces-search,traces-detail}.ts
// verbatim and merged into a single router.

import { Router, type Router as IRouter } from "express";
import { buildTraceListSql, type Filter, type Query } from "../query.js";
import { queryRows } from "../clickhouse.js";

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

    const { sql, params } = buildTraceListSql(q);
    const traces = await queryRows(sql, params);
    res.json({ traces });
  } catch (err) {
    next(err);
  }
});

obsTracesRouter.post("/traces/search", async (req, res, next) => {
  try {
    const q = (req.body ?? {}) as Query;
    const { sql, params } = buildTraceListSql(q);
    const traces = await queryRows(sql, params);
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
    const spans = await queryRows<SpanRow>(sql, { tid: traceId });
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
