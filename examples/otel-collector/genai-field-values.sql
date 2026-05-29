-- Materialized views for QueryBuilder autocomplete.
--
-- One destination table (otel_field_values) keyed by (field, value). One
-- materialized view per filterable field, each firing on INSERTs to
-- otel_traces. Reads use `countMerge` + `maxMerge` to fold the partial
-- aggregate states stored across parts.
--
-- Apply once after otel_traces exists:
--   docker exec -i clickhouse clickhouse-client --multiquery \
--     < examples/otel-collector/genai-field-values.sql
--
-- Drop everything:
--   docker exec clickhouse clickhouse-client --multiquery -q "\
--     DROP TABLE IF EXISTS otel.otel_field_values_agent_mv; \
--     ... (one per MV) \
--     DROP TABLE IF EXISTS otel.otel_field_values;"

-- ----------------------------------------------------------------------------
-- Destination
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS otel.otel_field_values (
  field      LowCardinality(String),
  value      String,
  last_seen  AggregateFunction(max, DateTime64(9)),
  span_count AggregateFunction(count)
) ENGINE = AggregatingMergeTree
ORDER BY (field, value)
SETTINGS index_granularity = 256;

-- ----------------------------------------------------------------------------
-- One MV per filterable field. Same shape; only the source expression differs.
-- ----------------------------------------------------------------------------

CREATE MATERIALIZED VIEW IF NOT EXISTS otel.otel_field_values_agent_mv
TO otel.otel_field_values AS
SELECT 'agent' AS field, SpanAttributes['gen_ai.agent.name'] AS value,
       maxState(Timestamp) AS last_seen, countState() AS span_count
FROM otel.otel_traces
WHERE SpanAttributes['gen_ai.agent.name'] != ''
GROUP BY field, value;

CREATE MATERIALIZED VIEW IF NOT EXISTS otel.otel_field_values_model_mv
TO otel.otel_field_values AS
SELECT 'model' AS field, SpanAttributes['gen_ai.request.model'] AS value,
       maxState(Timestamp) AS last_seen, countState() AS span_count
FROM otel.otel_traces
WHERE SpanAttributes['gen_ai.request.model'] != ''
GROUP BY field, value;

CREATE MATERIALIZED VIEW IF NOT EXISTS otel.otel_field_values_operation_mv
TO otel.otel_field_values AS
SELECT 'operation' AS field, SpanAttributes['gen_ai.operation.name'] AS value,
       maxState(Timestamp) AS last_seen, countState() AS span_count
FROM otel.otel_traces
WHERE SpanAttributes['gen_ai.operation.name'] != ''
GROUP BY field, value;

CREATE MATERIALIZED VIEW IF NOT EXISTS otel.otel_field_values_provider_mv
TO otel.otel_field_values AS
SELECT 'provider' AS field, SpanAttributes['gen_ai.provider.name'] AS value,
       maxState(Timestamp) AS last_seen, countState() AS span_count
FROM otel.otel_traces
WHERE SpanAttributes['gen_ai.provider.name'] != ''
GROUP BY field, value;

CREATE MATERIALIZED VIEW IF NOT EXISTS otel.otel_field_values_tool_mv
TO otel.otel_field_values AS
SELECT 'tool' AS field, SpanAttributes['gen_ai.tool.name'] AS value,
       maxState(Timestamp) AS last_seen, countState() AS span_count
FROM otel.otel_traces
WHERE SpanAttributes['gen_ai.tool.name'] != ''
GROUP BY field, value;

CREATE MATERIALIZED VIEW IF NOT EXISTS otel.otel_field_values_conversation_mv
TO otel.otel_field_values AS
SELECT 'conversation_id' AS field, SpanAttributes['gen_ai.conversation.id'] AS value,
       maxState(Timestamp) AS last_seen, countState() AS span_count
FROM otel.otel_traces
WHERE SpanAttributes['gen_ai.conversation.id'] != ''
GROUP BY field, value;

CREATE MATERIALIZED VIEW IF NOT EXISTS otel.otel_field_values_service_mv
TO otel.otel_field_values AS
SELECT 'service' AS field, ServiceName AS value,
       maxState(Timestamp) AS last_seen, countState() AS span_count
FROM otel.otel_traces
WHERE ServiceName != ''
GROUP BY field, value;

CREATE MATERIALIZED VIEW IF NOT EXISTS otel.otel_field_values_span_name_mv
TO otel.otel_field_values AS
SELECT 'span_name' AS field, SpanName AS value,
       maxState(Timestamp) AS last_seen, countState() AS span_count
FROM otel.otel_traces
WHERE SpanName != ''
GROUP BY field, value;

CREATE MATERIALIZED VIEW IF NOT EXISTS otel.otel_field_values_status_mv
TO otel.otel_field_values AS
SELECT 'status' AS field, StatusCode AS value,
       maxState(Timestamp) AS last_seen, countState() AS span_count
FROM otel.otel_traces
WHERE StatusCode != ''
GROUP BY field, value;

-- ----------------------------------------------------------------------------
-- Backfill — MVs only catch future inserts. Seed historical data from the
-- live otel_traces. Safe to re-run: AggregatingMergeTree dedupes by sort key.
-- ----------------------------------------------------------------------------

INSERT INTO otel.otel_field_values
SELECT 'agent', SpanAttributes['gen_ai.agent.name'], maxState(Timestamp), countState()
FROM otel.otel_traces WHERE SpanAttributes['gen_ai.agent.name'] != '' GROUP BY 1, 2;

INSERT INTO otel.otel_field_values
SELECT 'model', SpanAttributes['gen_ai.request.model'], maxState(Timestamp), countState()
FROM otel.otel_traces WHERE SpanAttributes['gen_ai.request.model'] != '' GROUP BY 1, 2;

INSERT INTO otel.otel_field_values
SELECT 'operation', SpanAttributes['gen_ai.operation.name'], maxState(Timestamp), countState()
FROM otel.otel_traces WHERE SpanAttributes['gen_ai.operation.name'] != '' GROUP BY 1, 2;

INSERT INTO otel.otel_field_values
SELECT 'provider', SpanAttributes['gen_ai.provider.name'], maxState(Timestamp), countState()
FROM otel.otel_traces WHERE SpanAttributes['gen_ai.provider.name'] != '' GROUP BY 1, 2;

INSERT INTO otel.otel_field_values
SELECT 'tool', SpanAttributes['gen_ai.tool.name'], maxState(Timestamp), countState()
FROM otel.otel_traces WHERE SpanAttributes['gen_ai.tool.name'] != '' GROUP BY 1, 2;

INSERT INTO otel.otel_field_values
SELECT 'conversation_id', SpanAttributes['gen_ai.conversation.id'], maxState(Timestamp), countState()
FROM otel.otel_traces WHERE SpanAttributes['gen_ai.conversation.id'] != '' GROUP BY 1, 2;

INSERT INTO otel.otel_field_values
SELECT 'service', ServiceName, maxState(Timestamp), countState()
FROM otel.otel_traces WHERE ServiceName != '' GROUP BY 1, 2;

INSERT INTO otel.otel_field_values
SELECT 'span_name', SpanName, maxState(Timestamp), countState()
FROM otel.otel_traces WHERE SpanName != '' GROUP BY 1, 2;

INSERT INTO otel.otel_field_values
SELECT 'status', StatusCode, maxState(Timestamp), countState()
FROM otel.otel_traces WHERE StatusCode != '' GROUP BY 1, 2;
