import { Router, type Router as IRouter } from "express";
import { queryRows } from "../clickhouse.js";

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

export const traceDetailRouter: IRouter = Router();

traceDetailRouter.get("/traces/:traceId", async (req, res, next) => {
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

    // Root = the span with no parent OR whose parent is not in this trace.
    const ids = new Set(spans.map((s) => s.SpanId));
    const root = spans.find((s) => !s.ParentSpanId || !ids.has(s.ParentSpanId)) ?? spans[0]!;

    res.json({ traceId, root, spans });
  } catch (err) {
    next(err);
  }
});
