-- Optional: run AFTER the first trace has landed (the ClickHouse exporter
-- creates otel_traces lazily on the first INSERT). Adds materialized columns
-- for the gen_ai.* attributes emitted by @computeragent/observability so
-- dashboards and ad-hoc queries don't scan the full SpanAttributes map.
--
-- Apply with either:
--   docker exec -i clickhouse clickhouse-client --multiquery < genai-materialized-columns.sql
-- or:
--   clickhouse-client --host localhost --port 9000 --database otel --multiquery < genai-materialized-columns.sql

ALTER TABLE otel.otel_traces
  ADD COLUMN IF NOT EXISTS gen_ai_operation         LowCardinality(String) MATERIALIZED SpanAttributes['gen_ai.operation.name'],
  ADD COLUMN IF NOT EXISTS gen_ai_provider          LowCardinality(String) MATERIALIZED SpanAttributes['gen_ai.provider.name'],
  ADD COLUMN IF NOT EXISTS gen_ai_request_model     LowCardinality(String) MATERIALIZED SpanAttributes['gen_ai.request.model'],
  ADD COLUMN IF NOT EXISTS gen_ai_agent_name        LowCardinality(String) MATERIALIZED SpanAttributes['gen_ai.agent.name'],
  ADD COLUMN IF NOT EXISTS gen_ai_agent_version     LowCardinality(String) MATERIALIZED SpanAttributes['gen_ai.agent.version'],
  ADD COLUMN IF NOT EXISTS gen_ai_conversation_id   String                 MATERIALIZED SpanAttributes['gen_ai.conversation.id'],
  ADD COLUMN IF NOT EXISTS gen_ai_tool_name         LowCardinality(String) MATERIALIZED SpanAttributes['gen_ai.tool.name'],
  ADD COLUMN IF NOT EXISTS gen_ai_tool_call_id      String                 MATERIALIZED SpanAttributes['gen_ai.tool.call.id'],
  ADD COLUMN IF NOT EXISTS gen_ai_input_tokens      UInt32                 MATERIALIZED toUInt32OrZero(SpanAttributes['gen_ai.usage.input_tokens']),
  ADD COLUMN IF NOT EXISTS gen_ai_output_tokens     UInt32                 MATERIALIZED toUInt32OrZero(SpanAttributes['gen_ai.usage.output_tokens']),
  ADD COLUMN IF NOT EXISTS gen_ai_cache_create_in   UInt32                 MATERIALIZED toUInt32OrZero(SpanAttributes['gen_ai.usage.cache_creation.input_tokens']),
  ADD COLUMN IF NOT EXISTS gen_ai_cache_read_in     UInt32                 MATERIALIZED toUInt32OrZero(SpanAttributes['gen_ai.usage.cache_read.input_tokens']),
  ADD COLUMN IF NOT EXISTS gen_ai_finish_reasons    Array(String)          MATERIALIZED arrayMap(x -> trim(BOTH '"' FROM x), splitByChar(',', trim(BOTH '[]' FROM SpanAttributes['gen_ai.response.finish_reasons']))),
  ADD COLUMN IF NOT EXISTS engine_name              LowCardinality(String) MATERIALIZED SpanAttributes['computeragent.engine.name'],
  ADD COLUMN IF NOT EXISTS cost_usd                 Float64                MATERIALIZED toFloat64OrZero(SpanAttributes['computeragent.usage.cost_usd']);

-- Skip index speeds up filters like  WHERE gen_ai_conversation_id = 'sess_...'
ALTER TABLE otel.otel_traces
  ADD INDEX IF NOT EXISTS idx_gen_ai_conversation gen_ai_conversation_id TYPE bloom_filter GRANULARITY 4;

-- Sanity queries:
--
--   -- Token + cost rollup per model:
--   SELECT gen_ai_provider, gen_ai_request_model,
--          count() AS calls,
--          sum(gen_ai_input_tokens) AS in_tokens,
--          sum(gen_ai_output_tokens) AS out_tokens,
--          sum(cost_usd) AS usd
--   FROM otel.otel_traces
--   WHERE gen_ai_operation = 'invoke_agent'
--   GROUP BY gen_ai_provider, gen_ai_request_model;
--
--   -- Per-tool latency:
--   SELECT gen_ai_tool_name,
--          count() AS calls,
--          quantile(0.5)(Duration / 1e6) AS p50_ms,
--          quantile(0.95)(Duration / 1e6) AS p95_ms
--   FROM otel.otel_traces
--   WHERE gen_ai_operation = 'execute_tool'
--   GROUP BY gen_ai_tool_name;
--
--   -- Token-usage histogram landed in the metrics table:
--   SELECT * FROM otel.otel_metrics_histogram
--   WHERE MetricName = 'gen_ai.client.token.usage'
--   ORDER BY TimeUnix DESC LIMIT 10;
