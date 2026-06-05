// Observability — traces list, search, detail.
//
// Dispatches to ClickHouse or New Relic based on the TRACE_BACKEND env var.
// Both backends return the same JSON shape so the UI doesn't care.

import { Router, type Router as IRouter } from "express";
import { buildTraceListSql, buildNrqlTraceListQuery, ownerScopeFor, type Filter, type Query } from "../query.js";
import { queryRows as chQueryRows } from "../clickhouse.js";
import { queryRows as nrqlQueryRows } from "../new-relic.js";
import { traceBackend } from "../trace-backend.js";
import { canRead, isSuperuser, type Owned } from "../auth/ownership.js";

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
    // RBAC: scope to the caller's readable group/owner (no-op for superusers).
    q.scope = ownerScopeFor(res.locals.principal);

    const traces = await fetchTraceList(q);
    res.json({ traces });
  } catch (err) {
    next(err);
  }
});

obsTracesRouter.post("/traces/search", async (req, res, next) => {
  try {
    const q = (req.body ?? {}) as Query;
    // RBAC: always overwrite any client-supplied scope with the caller's own —
    // the scope is server-authoritative, never trusted from the request body.
    q.scope = ownerScopeFor(res.locals.principal);
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
    // RBAC (IDOR guard): a non-superuser may only fetch a trace whose owner/group
    // they can read. Derive owner/group from the trace's spans and 404 (not 403,
    // to avoid confirming existence) when not allowed. Untagged/legacy traces
    // have no owner/group → admin-only, matching the list-filter's deny default.
    if (!isSuperuser(res.locals.principal)) {
      if (!canRead(res.locals.principal, ownedFromSpans(spans))) {
        return res.status(404).json({ error: "trace not found" });
      }
    }
    const ids = new Set(spans.map((s) => s.SpanId));
    const root = spans.find((s) => !s.ParentSpanId || !ids.has(s.ParentSpanId)) ?? spans[0]!;
    res.json({ traceId, root, spans });
  } catch (err) {
    next(err);
  }
});

/**
 * Derive the owner/group of a trace from its spans for the RBAC visibility
 * check. Identity is stamped on every span, so we take the first span carrying
 * a non-empty owner or group. A trace with neither (legacy/untagged) yields an
 * unowned resource → visible to admins only (canRead denies non-superusers).
 */
function ownedFromSpans(spans: SpanRow[]): Owned {
  for (const s of spans) {
    const ownerUser = s.SpanAttributes?.["computeragent.owner.id"] || null;
    const ownerGroup = s.SpanAttributes?.["computeragent.group.id"] || null;
    if (ownerUser || ownerGroup) return { ownerUser, ownerGroup };
  }
  return { ownerUser: null, ownerGroup: null };
}

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
 * Lookback window (ms) for the trace-detail query. NRQL defaults to a 1-hour
 * window when no SINCE is given, which made any trace older than ~1h 404 even
 * though the trace list (which honors the UI's selected range, up to 72h) still
 * showed it. A `trace.id` lookup is globally unique, so a wide SINCE is safe —
 * it can only ever match this one trace. Default 8 days = NR raw-span retention
 * ceiling; override with NEW_RELIC_TRACE_LOOKBACK_DAYS for longer-retention plans.
 */
function traceDetailLookbackMs(): number {
  const raw = process.env["NEW_RELIC_TRACE_LOOKBACK_DAYS"];
  const days = raw ? parseInt(raw, 10) : NaN;
  const safe = Number.isFinite(days) && days > 0 ? days : 8;
  return safe * 24 * 60 * 60 * 1000;
}

/**
 * NRQL doesn't surface span attributes as a single `SpanAttributes` map — they
 * are flattened onto the Span event. We `SELECT *` for the trace ID, then
 * re-bundle attributes client-side to match the ClickHouse shape the UI expects.
 *
 * NRQL has a hard limit (default 2000) on rows per query. Traces with more than
 * 2000 spans get truncated; this matches ClickHouse's pragmatic behavior.
 *
 * The explicit SINCE is required: without it NRQL only scans the last hour, so
 * older traces returned zero spans and the route 404'd. See traceDetailLookbackMs.
 */
async function fetchTraceDetailNrql(traceId: string): Promise<SpanRow[]> {
  const since = new Date(Date.now() - traceDetailLookbackMs());
  const rows = await nrqlQueryRows<Record<string, unknown>>(
    `SELECT * FROM Span WHERE trace.id = {tid:String} SINCE {since:Timestamp} LIMIT 2000`,
    { tid: traceId, since },
  );
  return mapNrqlSpans(rows);
}

const NRQL_FRAME_KEYS = new Set([
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

/**
 * NRQL `SELECT * FROM Span` returns attributes flattened onto the event. Re-
 * bundle them into the `SpanAttributes` / `ResourceAttributes` maps the UI
 * expects (the ClickHouse shape), and time-sort. Shared by the trace-detail
 * and conversation-detail paths.
 */
function mapNrqlSpans(rows: Array<Record<string, unknown>>): SpanRow[] {
  return rows
    .map((row): SpanRow => {
      const spanAttributes: Record<string, string> = {};
      const resourceAttributes: Record<string, string> = {};
      for (const [k, v] of Object.entries(row)) {
        if (NRQL_FRAME_KEYS.has(k)) continue;
        const sv = v == null ? "" : String(v);
        // Heuristic: `service.*`, `host.*`, `cloud.*`, `k8s.*` are resource-level.
        if (/^(service|host|cloud|k8s|container|process|telemetry)\./.test(k)) {
          resourceAttributes[k] = sv;
        } else {
          spanAttributes[k] = sv;
        }
      }
      return {
        TraceId: String(row["trace.id"] ?? ""),
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
