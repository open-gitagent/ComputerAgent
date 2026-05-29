import { FIELDS, type Operator } from "./fields.js";
import { parseTime, toClickHouseDateTime } from "./time.js";

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
