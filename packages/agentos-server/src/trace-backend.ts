// Selects which trace backend the observability routes talk to.
//
// During the migration, both ClickHouse and New Relic are available. The
// TRACE_BACKEND env var picks one at boot time:
//
//   TRACE_BACKEND=clickhouse  → legacy path (default during migration)
//   TRACE_BACKEND=newrelic    → NerdGraph + NRQL (post cut-over)
//
// The choice is process-wide and immutable for the life of the process —
// flipping it requires a redeploy. This is intentional: queries reach into
// the picked backend's helpers, and we don't want mid-request switching.

export type TraceBackend = "clickhouse" | "newrelic";

let cached: TraceBackend | null = null;

export function traceBackend(): TraceBackend {
  if (cached !== null) return cached;
  const raw = (process.env["TRACE_BACKEND"] ?? "clickhouse").toLowerCase();
  if (raw === "newrelic") {
    cached = "newrelic";
  } else if (raw === "clickhouse") {
    cached = "clickhouse";
  } else {
    throw new Error(
      `TRACE_BACKEND must be "clickhouse" or "newrelic" (got "${raw}")`,
    );
  }
  return cached;
}

/** Test hook — override the cached selection. Do not call from production code. */
export function _setTraceBackendForTests(b: TraceBackend | null): void {
  cached = b;
}
