# OTel Collector → ClickHouse (+ console)

Self-contained pipeline for the `gen_ai.*` spans, metrics, and logs emitted by
`@computeragent/observability`. The collector receives OTLP and fans out to
**two** exporters in parallel:

- `debug` — prints every span/metric to stdout for live inspection.
- `clickhouse` — writes to the bundled ClickHouse (or any ClickHouse you point
  it at via env vars).

## Files

| File | Purpose |
|---|---|
| `docker-compose.yml` | Spins up `otel-collector` + `clickhouse`. |
| `otel-collector-config.yaml` | Receivers, processors, dual exporters. |
| `.env.example` | Connection params (copy to `.env`). |
| `genai-materialized-columns.sql` | Optional post-init DDL for fast `gen_ai.*` queries. |
| `otel-localhost-claude.ts` | Single-turn demo: one `invoke_agent` → `chat` → `execute_tool`. Good for first-look smoke test. |
| `otel-multi-turn-claude.ts` | Multi-turn demo: **three** `invoke_agent` traces correlated by `gen_ai.conversation.id`, each with multiple chat→tool children (Write × 3, Read × 3 + Write, Bash). Shows the full GenAI trace tree across a real conversation. |

## Run

```bash
cd examples/otel-collector
cp .env.example .env            # adjust if pointing at external ClickHouse
docker compose up -d

# tail the collector (debug exporter prints every span/metric)
docker compose logs -f otel-collector
```

ClickHouse is exposed on:
- `localhost:9000` — native protocol (the exporter uses this).
- `localhost:8123` — HTTP interface (use this for `clickhouse-client`,
  Grafana, JetBrains DataGrip, etc.).

## Send the demo's traces through it

Single-turn (~3 spans):

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 \
  ANTHROPIC_API_KEY=sk-ant-... \
  bun run examples/otel-collector/otel-localhost-claude.ts
```

Multi-turn (~30+ spans, three correlated `invoke_agent` roots):

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 \
  ANTHROPIC_API_KEY=sk-ant-... \
  bun run examples/otel-collector/otel-multi-turn-claude.ts
```

You'll see `invoke_agent`, `chat`, and `execute_tool` spans plus the
`gen_ai.client.token.usage`, `gen_ai.client.operation.duration`, and
`computeragent.usage.cost_usd` histograms land in **both** stdout and
ClickHouse. The multi-turn variant additionally shows three separate
trace IDs all sharing the same `gen_ai.conversation.id` attribute — group
by that field in your query layer to roll up per-conversation usage and
cost.

## Verify rows in ClickHouse

```bash
docker exec -it clickhouse clickhouse-client --database otel \
  --query "SELECT TraceId, SpanName, SpanKind, Duration FROM otel_traces ORDER BY Timestamp DESC LIMIT 10"
```

Default tables created by the exporter:

| Table | Signal |
|---|---|
| `otel_traces` | spans |
| `otel_logs` | logs |
| `otel_metrics_sum` / `_gauge` / `_histogram` / `_exponential_histogram` / `_summary` | metrics |

Span attributes (incl. all `gen_ai.*`) land in `SpanAttributes Map(String, String)`.
Resource attributes (`service.name`, `telemetry.sdk.*`) land in
`ResourceAttributes Map(String, String)`.

## Make `gen_ai.*` queries fast

After the first span lands (so `otel_traces` exists), run:

```bash
docker exec -i clickhouse clickhouse-client --multiquery \
  < examples/otel-collector/genai-materialized-columns.sql
```

This adds materialized columns for `gen_ai.operation.name`,
`gen_ai.request.model`, `gen_ai.usage.{input,output}_tokens`, the cache-token
attributes, `gen_ai.tool.name`, `gen_ai.conversation.id`, and the custom
`computeragent.usage.cost_usd`, plus a bloom filter on conversation id. The
file's footer has sample roll-up queries.

## Point at an external ClickHouse

Edit `.env`:

```env
CLICKHOUSE_ENDPOINT=tcp://your-ch-host:9000?secure=true&dial_timeout=10s&compress=lz4
CLICKHOUSE_DATABASE=lyzr_traces
CLICKHOUSE_USER=otel_writer
CLICKHOUSE_PASSWORD=...
```

Then either drop the `clickhouse` service from `docker-compose.yml` or just
ignore it (the collector talks to whatever `CLICKHOUSE_ENDPOINT` resolves to).

## Tuning

- **Drop console once you trust ClickHouse**: in `otel-collector-config.yaml`,
  remove `debug` from each pipeline's `exporters: [...]`.
- **Lower verbosity**: change `exporters.debug.verbosity` to `normal` (one line
  per span) or `basic` (counts only).
- **TTL**: `exporters.clickhouse.ttl: 72h` controls retention on the
  exporter-created tables. Change before first boot or alter tables after.
- **Production DDL**: flip `create_schema: false` and manage tables yourself.
  See the [exporter README](https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/main/exporter/clickhouseexporter/README.md)
  for the canonical DDL templates.
