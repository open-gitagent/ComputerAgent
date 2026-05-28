// Bootstrap migrations run on obs-api startup. Currently:
//   1. `otel_field_values` destination table (AggregatingMergeTree)
//   2. One materialized view per filterable field (9 total)
//   3. Backfill from `otel_traces` if the destination is empty
//
// All DDL is idempotent (`CREATE … IF NOT EXISTS`). Safe to run every boot.
// If `otel_traces` doesn't exist yet (fresh stack, no spans ingested), the
// whole thing is skipped with a warning — `/v1/fields/:name/values` falls
// back to the DISTINCT-scan path until the next obs-api restart.
//
// The canonical SQL form of these migrations lives at:
//   examples/otel-collector/genai-field-values.sql
// Kept in sync manually.

import { getClient } from "./clickhouse.js";

type MvDef = {
  /** Logical field key written to `otel_field_values.field`. */
  field: string;
  /** ClickHouse expression that extracts the value from an `otel_traces` row. */
  expr: string;
  /** MV table name in the `otel` database. */
  mvName: string;
};

const MV_FIELDS: MvDef[] = [
  { field: "agent",           expr: "SpanAttributes['gen_ai.agent.name']",      mvName: "otel_field_values_agent_mv" },
  { field: "model",           expr: "SpanAttributes['gen_ai.request.model']",   mvName: "otel_field_values_model_mv" },
  { field: "operation",       expr: "SpanAttributes['gen_ai.operation.name']",  mvName: "otel_field_values_operation_mv" },
  { field: "provider",        expr: "SpanAttributes['gen_ai.provider.name']",   mvName: "otel_field_values_provider_mv" },
  { field: "tool",            expr: "SpanAttributes['gen_ai.tool.name']",       mvName: "otel_field_values_tool_mv" },
  { field: "conversation_id", expr: "SpanAttributes['gen_ai.conversation.id']", mvName: "otel_field_values_conversation_mv" },
  { field: "service",         expr: "ServiceName",                              mvName: "otel_field_values_service_mv" },
  { field: "span_name",       expr: "SpanName",                                 mvName: "otel_field_values_span_name_mv" },
  { field: "status",          expr: "StatusCode",                               mvName: "otel_field_values_status_mv" },
];

async function tableExists(name: string): Promise<boolean> {
  const client = getClient();
  const rs = await client.query({
    query: `SELECT 1 AS one FROM system.tables
            WHERE database = currentDatabase() AND name = {name:String}
            LIMIT 1`,
    query_params: { name },
    format: "JSONEachRow",
  });
  const rows = (await rs.json()) as unknown[];
  return rows.length > 0;
}

async function rowCount(table: string): Promise<number> {
  const client = getClient();
  const rs = await client.query({
    query: `SELECT count() AS c FROM ${table}`,
    format: "JSONEachRow",
  });
  const rows = (await rs.json()) as Array<{ c: number | string }>;
  return Number(rows[0]?.c ?? 0);
}

export async function ensureFieldValueMVs(): Promise<{
  status: "skipped" | "ready" | "created-and-backfilled";
  reason?: string;
}> {
  const client = getClient();

  if (!(await tableExists("otel_traces"))) {
    return {
      status: "skipped",
      reason: "otel_traces does not exist yet (no spans ingested) — restart obs-api after the collector has written data",
    };
  }

  // 1. Destination table — idempotent.
  await client.command({
    query: `
      CREATE TABLE IF NOT EXISTS otel_field_values (
        field      LowCardinality(String),
        value      String,
        last_seen  AggregateFunction(max, DateTime64(9)),
        span_count AggregateFunction(count)
      ) ENGINE = AggregatingMergeTree
      ORDER BY (field, value)
      SETTINGS index_granularity = 256
    `,
  });

  // 2. Materialized views — one per field. Idempotent via IF NOT EXISTS.
  //    AggregatingMergeTree merges duplicates with the same (field, value)
  //    at storage time, so re-runs don't bloat.
  for (const f of MV_FIELDS) {
    await client.command({
      query: `
        CREATE MATERIALIZED VIEW IF NOT EXISTS ${f.mvName}
        TO otel_field_values AS
        SELECT '${f.field}' AS field,
               ${f.expr}     AS value,
               maxState(Timestamp)    AS last_seen,
               countState()           AS span_count
        FROM otel_traces
        WHERE ${f.expr} != ''
        GROUP BY field, value
      `,
    });
  }

  // 3. Backfill — only if the destination is empty (fresh bootstrap).
  //    Skipped on subsequent restarts where the MVs are already catching
  //    inserts incrementally.
  const existing = await rowCount("otel_field_values");
  if (existing > 0) {
    return { status: "ready" };
  }

  for (const f of MV_FIELDS) {
    await client.command({
      query: `
        INSERT INTO otel_field_values
        SELECT '${f.field}', ${f.expr}, maxState(Timestamp), countState()
        FROM otel_traces WHERE ${f.expr} != '' GROUP BY 1, 2
      `,
    });
  }

  return { status: "created-and-backfilled" };
}
