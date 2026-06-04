import { FIELDS, type Operator } from "./fields.js";
import { parseTime, toClickHouseDateTime } from "./time.js";

// ─── ClickHouse builders (existing) ──────────────────────────────────────
//
// The ClickHouse-flavored builders (buildWhere, buildListSql, buildTraceListSql)
// are kept verbatim during the migration. New NRQL counterparts are added in
// the section labelled "NRQL builders" below. Route handlers select between
// them based on the TRACE_BACKEND env var.

export type Filter = {
  field: string;
  op: Operator;
  value?: string | number | string[] | number[];
};

export type Query = {
  filters?: Filter[];
  from?: string;
  to?: string;
  limit?: number;
  orderBy?: "timestamp" | "duration_ms" | "cost_usd" | "input_tokens" | "output_tokens";
  orderDir?: "asc" | "desc";
  /**
   * Cursor for time-descending pagination (ms since epoch). Returns only
   * spans/traces strictly older than this. The SPA sets it to the oldest
   * `started_at_ms` already shown to fetch the next page (NRQL has no OFFSET,
   * so pagination is a time cursor). Short-lived per-turn traces don't straddle
   * the ms boundary in practice; the client dedupes by TraceId regardless.
   */
  before?: number;
};

const ORDER_BY_MAP: Record<NonNullable<Query["orderBy"]>, string> = {
  timestamp: "Timestamp",
  duration_ms: "Duration",
  cost_usd: "toFloat64OrZero(SpanAttributes['computeragent.usage.cost_usd'])",
  input_tokens: "toUInt32OrZero(SpanAttributes['gen_ai.usage.input_tokens'])",
  output_tokens: "toUInt32OrZero(SpanAttributes['gen_ai.usage.output_tokens'])",
};

export class BadQueryError extends Error {
  status = 400;
  constructor(msg: string) {
    super(msg);
  }
}

export type Built = { where: string; params: Record<string, unknown> };

export function buildWhere(query: Query): Built {
  const params: Record<string, unknown> = {};
  const clauses: string[] = [];

  if (query.from) {
    params["t_from"] = toClickHouseDateTime(parseTime(query.from));
    clauses.push(`Timestamp >= parseDateTime64BestEffort({t_from:String}, 9)`);
  }
  if (query.to) {
    params["t_to"] = toClickHouseDateTime(parseTime(query.to));
    clauses.push(`Timestamp < parseDateTime64BestEffort({t_to:String}, 9)`);
  }
  if (query.before !== undefined) {
    params["before_ms"] = query.before;
    clauses.push(`Timestamp < fromUnixTimestamp64Milli({before_ms:Int64})`);
  }

  let i = 0;
  for (const f of query.filters ?? []) {
    const def = FIELDS[f.field];
    if (!def) throw new BadQueryError(`unknown field: ${f.field}`);
    if (!def.ops.includes(f.op)) throw new BadQueryError(`field ${f.field} does not support op ${f.op}`);

    const pkey = `p${i++}`;

    if (f.op === "exists") {
      clauses.push(`${def.sqlExpr} != ''`);
      continue;
    }
    if (f.op === "in" || f.op === "not_in") {
      if (!Array.isArray(f.value)) throw new BadQueryError(`${f.op} requires array value`);
      params[pkey] = f.value;
      clauses.push(`${def.sqlExpr} ${f.op === "in" ? "IN" : "NOT IN"} ({${pkey}:Array(${def.paramType})})`);
      continue;
    }
    if (f.op === "contains") {
      if (typeof f.value !== "string") throw new BadQueryError(`contains requires string value`);
      params[pkey] = `%${f.value}%`;
      clauses.push(`${def.sqlExpr} LIKE {${pkey}:String}`);
      continue;
    }
    if (f.value === undefined || f.value === null || Array.isArray(f.value)) {
      throw new BadQueryError(`${f.op} requires scalar value`);
    }
    params[pkey] = f.value;
    const sym = f.op === "eq" ? "=" : f.op === "neq" ? "!=" : f.op === "gt" ? ">" : f.op === "gte" ? ">=" : f.op === "lt" ? "<" : ">=";
    const realSym = f.op === "lte" ? "<=" : sym;
    clauses.push(`${def.sqlExpr} ${realSym} {${pkey}:${def.paramType}}`);
  }

  return { where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params };
}

export function buildListSql(query: Query): { sql: string; params: Record<string, unknown> } {
  const { where, params } = buildWhere(query);
  const limit = Math.max(1, Math.min(1000, query.limit ?? 100));
  const orderCol = ORDER_BY_MAP[query.orderBy ?? "timestamp"];
  const orderDir = (query.orderDir ?? "desc").toUpperCase() === "ASC" ? "ASC" : "DESC";

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
      SpanAttributes['gen_ai.agent.name']        AS agent,
      SpanAttributes['gen_ai.request.model']     AS model,
      SpanAttributes['gen_ai.operation.name']    AS operation,
      SpanAttributes['gen_ai.provider.name']     AS provider,
      SpanAttributes['gen_ai.tool.name']         AS tool,
      SpanAttributes['gen_ai.conversation.id']   AS conversation_id,
      toUInt32OrZero(SpanAttributes['gen_ai.usage.input_tokens'])  AS input_tokens,
      toUInt32OrZero(SpanAttributes['gen_ai.usage.output_tokens']) AS output_tokens,
      toFloat64OrZero(SpanAttributes['computeragent.usage.cost_usd']) AS cost_usd
    FROM otel_traces
    ${where}
    ORDER BY ${orderCol} ${orderDir}
    LIMIT ${limit}
  `;
  return { sql, params };
}

const TRACE_ORDER_BY_MAP: Record<NonNullable<Query["orderBy"]>, string> = {
  timestamp: "started_at_ms",
  duration_ms: "duration_ms",
  cost_usd: "cost_usd",
  input_tokens: "input_tokens",
  output_tokens: "output_tokens",
};

export function buildTraceListSql(query: Query): { sql: string; params: Record<string, unknown> } {
  const { where, params } = buildWhere(query);
  const limit = Math.max(1, Math.min(500, query.limit ?? 100));
  const orderCol = TRACE_ORDER_BY_MAP[query.orderBy ?? "timestamp"];
  const orderDir = (query.orderDir ?? "desc").toUpperCase() === "ASC" ? "ASC" : "DESC";

  const outerTime: string[] = [];
  if (params["t_from"] !== undefined) {
    outerTime.push(`Timestamp >= parseDateTime64BestEffort({t_from:String}, 9)`);
  }
  if (params["t_to"] !== undefined) {
    outerTime.push(`Timestamp < parseDateTime64BestEffort({t_to:String}, 9)`);
  }
  const outerTimeClause = outerTime.length ? `AND ${outerTime.join(" AND ")}` : "";

  const sql = `
    SELECT
      TraceId,
      argMin(SpanName, Timestamp)                              AS root_span_name,
      argMin(ServiceName, Timestamp)                           AS service_name,
      argMin(SpanAttributes['gen_ai.agent.name'], Timestamp)   AS agent,
      argMin(SpanAttributes['gen_ai.request.model'], Timestamp) AS model,
      argMin(SpanAttributes['gen_ai.operation.name'], Timestamp) AS root_operation,
      argMin(SpanAttributes['gen_ai.provider.name'], Timestamp) AS provider,
      argMin(SpanAttributes['gen_ai.conversation.id'], Timestamp) AS conversation_id,
      argMin((Duration / 1e6), Timestamp)                       AS duration_ms,
      toUnixTimestamp64Milli(min(Timestamp))                    AS started_at_ms,
      count()                                                   AS span_count,
      sum(toUInt32OrZero(SpanAttributes['gen_ai.usage.input_tokens']))  AS input_tokens,
      sum(toUInt32OrZero(SpanAttributes['gen_ai.usage.output_tokens'])) AS output_tokens,
      sum(toFloat64OrZero(SpanAttributes['computeragent.usage.cost_usd'])) AS cost_usd,
      countIf(StatusCode IN ('Error','STATUS_CODE_ERROR'))      AS error_count
    FROM otel_traces
    WHERE TraceId IN (
      SELECT DISTINCT TraceId FROM otel_traces ${where}
    )
    ${outerTimeClause}
    GROUP BY TraceId
    ORDER BY ${orderCol} ${orderDir}
    LIMIT ${limit}
  `;
  return { sql, params };
}

// ─────────────────────────────────────────────────────────────────────────────
// NRQL builders — parallel to the ClickHouse builders above.
//
// NRQL has no parameterized-query support, so values are substituted client-
// side. The {paramName:Type} placeholders are interpolated by `renderNrql`
// in new-relic.ts; the same `params` shape works for both backends.
// ─────────────────────────────────────────────────────────────────────────────

const NRQL_ORDER_BY_MAP: Record<NonNullable<Query["orderBy"]>, string> = {
  timestamp: "timestamp",
  duration_ms: "duration.ms",
  cost_usd: "computeragent.usage.cost_usd",
  input_tokens: "gen_ai.usage.input_tokens",
  output_tokens: "gen_ai.usage.output_tokens",
};

// Order faceted trace rows by the bare SELECT alias — NOT a raw aggregate
// function (NRQL rejects `ORDER BY min(timestamp) DESC` → "unexpected DESC")
// and NOT a backticked name (backticks mean an *attribute*; NR then can't find
// the alias and silently falls back to default facet order — the original
// jumble bug). A bare alias like `started_at_ms` references the computed column
// and sorts correctly. Each value here MUST be aliased in the SELECT below.
const NRQL_TRACE_ORDER_BY_MAP: Record<NonNullable<Query["orderBy"]>, string> = {
  timestamp: "started_at_ms",
  duration_ms: "duration_ms",
  cost_usd: "cost_usd",
  input_tokens: "input_tokens",
  output_tokens: "output_tokens",
};

/** NRQL "SINCE ... UNTIL ..." clause from the Query's `from`/`to` window. */
export function buildNrqlTimeWindow(query: Query): { clause: string; params: Record<string, unknown> } {
  const params: Record<string, unknown> = {};
  const parts: string[] = [];
  if (query.from) {
    params["t_from"] = parseTime(query.from);
    parts.push(`SINCE {t_from:Timestamp}`);
  }
  if (query.to) {
    params["t_to"] = parseTime(query.to);
    parts.push(`UNTIL {t_to:Timestamp}`);
  }
  return { clause: parts.join(" "), params };
}

export type NrqlBuilt = { where: string; params: Record<string, unknown> };

/**
 * Build the NRQL WHERE clause for the given filters. Does NOT include the
 * SINCE/UNTIL portion — callers append `buildNrqlTimeWindow(query).clause`
 * separately, because NRQL keeps time bounds outside the WHERE.
 */
export function buildNrqlWhere(query: Query): NrqlBuilt {
  const params: Record<string, unknown> = {};
  const clauses: string[] = [];

  if (query.before !== undefined) {
    // Time-cursor pagination: only spans older than the cursor (ms epoch).
    // NRQL `timestamp` is a numeric ms-epoch field; compare numerically
    // (Float64 renders the raw number — Timestamp would emit a quoted ISO).
    params["before_ms"] = query.before;
    clauses.push(`timestamp < {before_ms:Float64}`);
  }

  let i = 0;
  for (const f of query.filters ?? []) {
    const def = FIELDS[f.field];
    if (!def) throw new BadQueryError(`unknown field: ${f.field}`);
    if (!def.ops.includes(f.op)) throw new BadQueryError(`field ${f.field} does not support op ${f.op}`);

    const pkey = `p${i++}`;
    const attr = `\`${def.nrqlAttr}\``; // backtick-quote to be safe with dotted names

    if (f.op === "exists") {
      // NRQL doesn't have a generic "IS NOT NULL". Empty-string sentinel matches the ClickHouse semantics.
      clauses.push(`${attr} IS NOT NULL AND ${attr} != ''`);
      continue;
    }
    if (f.op === "in" || f.op === "not_in") {
      if (!Array.isArray(f.value)) throw new BadQueryError(`${f.op} requires array value`);
      const innerType = def.paramType === "String" ? "Array(String)" : `Array(${def.paramType})`;
      params[pkey] = f.value;
      clauses.push(`${attr} ${f.op === "in" ? "IN" : "NOT IN"} {${pkey}:${innerType}}`);
      continue;
    }
    if (f.op === "contains") {
      if (typeof f.value !== "string") throw new BadQueryError(`contains requires string value`);
      params[pkey] = `%${f.value}%`;
      clauses.push(`${attr} LIKE {${pkey}:String}`);
      continue;
    }
    if (f.value === undefined || f.value === null || Array.isArray(f.value)) {
      throw new BadQueryError(`${f.op} requires scalar value`);
    }
    params[pkey] = f.value;
    const sym = f.op === "eq" ? "=" : f.op === "neq" ? "!=" : f.op === "gt" ? ">" : f.op === "gte" ? ">=" : f.op === "lt" ? "<" : "<=";
    clauses.push(`${attr} ${sym} {${pkey}:${def.paramType}}`);
  }

  return {
    where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "",
    params,
  };
}

/**
 * Build the NRQL `SELECT ... FROM Span` for the per-span list view.
 * Equivalent to `buildListSql` for the ClickHouse backend.
 */
export function buildNrqlListQuery(query: Query): { nrql: string; params: Record<string, unknown> } {
  const { where, params: whereParams } = buildNrqlWhere(query);
  const { clause: time, params: timeParams } = buildNrqlTimeWindow(query);
  const params = { ...whereParams, ...timeParams };
  const limit = Math.max(1, Math.min(1000, query.limit ?? 100));
  const orderCol = NRQL_ORDER_BY_MAP[query.orderBy ?? "timestamp"];
  const orderDir = (query.orderDir ?? "desc").toUpperCase() === "ASC" ? "ASC" : "DESC";

  // NRQL's `SELECT ... FROM Span` returns the canonical span attributes flattened.
  // We alias the dotted names to keys the existing UI consumes.
  const nrql = `
    SELECT
      trace.id                            AS TraceId,
      id                                  AS SpanId,
      parent.id                           AS ParentSpanId,
      name                                AS SpanName,
      span.kind                           AS SpanKind,
      service.name                        AS ServiceName,
      timestamp                           AS ts_ms,
      duration.ms                         AS duration_ms,
      otel.status_code                    AS StatusCode,
      otel.status_description             AS StatusMessage,
      \`gen_ai.agent.name\`               AS agent,
      \`gen_ai.request.model\`            AS model,
      \`gen_ai.operation.name\`           AS operation,
      \`gen_ai.provider.name\`            AS provider,
      \`gen_ai.tool.name\`                AS tool,
      \`gen_ai.conversation.id\`          AS conversation_id,
      \`gen_ai.usage.input_tokens\`       AS input_tokens,
      \`gen_ai.usage.output_tokens\`      AS output_tokens,
      \`computeragent.usage.cost_usd\`    AS cost_usd
    FROM Span
    ${where}
    ${time}
    ORDER BY \`${orderCol}\` ${orderDir}
    LIMIT ${limit}
  `;
  return { nrql, params };
}

/**
 * Build the NRQL trace-list query — equivalent to `buildTraceListSql`.
 *
 * ClickHouse uses a single SQL with `argMin(..., Timestamp)` over each TraceId
 * group. NRQL has no `argMin`, so we approximate with a per-trace `FACET trace.id`
 * + `latest()`/`min()`/`sum()`/`count()` aggregates. The fields the UI consumes
 * line up to within rounding; the difference is that `latest()` returns the
 * most-recent value rather than the earliest, which is acceptable for traces
 * (root span attributes are typically identical to the latest span's).
 *
 * For exact `argMin(..., Timestamp)` semantics, the route handler can fall back
 * to a two-roundtrip approach: first fetch the trace IDs, then fetch each
 * trace's root span. The default `latest()` path is faster and usually correct.
 */
export function buildNrqlTraceListQuery(query: Query): { nrql: string; params: Record<string, unknown> } {
  const { where, params: whereParams } = buildNrqlWhere(query);
  const { clause: time, params: timeParams } = buildNrqlTimeWindow(query);
  const params = { ...whereParams, ...timeParams };
  const limit = Math.max(1, Math.min(500, query.limit ?? 100));
  const orderCol = NRQL_TRACE_ORDER_BY_MAP[query.orderBy ?? "timestamp"];
  const orderDir = (query.orderDir ?? "desc").toUpperCase() === "ASC" ? "ASC" : "DESC";

  // root_span_name / root_operation / duration MUST come from the trace's ROOT
  // span (the one with no parent — the per-turn `invoke_agent`), NOT `latest()`.
  // `latest(name)` returns the most-recent span (typically a tool like
  // `execute_tool Read`), so the trace row would mislabel as "Read" instead of
  // "invoke_agent <agent>". `filter(latest(x), WHERE parent.id IS NULL)` pins
  // these to the root. agent/model/provider/conversation use plain latest()
  // because they only appear on the root anyway and latest() skips nulls.
  const nrql = `
    SELECT
      filter(latest(name), WHERE parent.id IS NULL)                 AS root_span_name,
      latest(service.name)                                          AS service_name,
      latest(\`gen_ai.agent.name\`)                                 AS agent,
      latest(\`gen_ai.request.model\`)                              AS model,
      filter(latest(\`gen_ai.operation.name\`), WHERE parent.id IS NULL) AS root_operation,
      latest(\`gen_ai.provider.name\`)                              AS provider,
      latest(\`gen_ai.conversation.id\`)                            AS conversation_id,
      filter(latest(duration.ms), WHERE parent.id IS NULL)          AS duration_ms,
      min(timestamp)                                                AS started_at_ms,
      count(*)                                                      AS span_count,
      sum(\`gen_ai.usage.input_tokens\`)                            AS input_tokens,
      sum(\`gen_ai.usage.output_tokens\`)                           AS output_tokens,
      sum(\`computeragent.usage.cost_usd\`)                         AS cost_usd,
      filter(count(*), WHERE otel.status_code IN ('Error', 'STATUS_CODE_ERROR')) AS error_count
    FROM Span
    ${where}
    ${time}
    FACET trace.id
    ORDER BY ${orderCol} ${orderDir}
    LIMIT ${limit}
  `;
  return { nrql, params };
}

