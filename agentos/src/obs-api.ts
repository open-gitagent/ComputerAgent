// Typed client for packages/observability-api. Same patterns as ./api.ts but
// hits the local Express service via Vite's /obs-api proxy.

import type { Operator } from "./obs-fields.ts";

// Per-trace aggregate — one row per TraceId in /v1/traces and /v1/traces/search.
export interface TraceSummary {
  TraceId: string;
  root_span_name: string;
  service_name: string;
  agent: string;
  model: string;
  root_operation: string;
  provider: string;
  conversation_id: string;
  duration_ms: number;       // root span's duration
  started_at_ms: number;     // ms since epoch
  span_count: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  error_count: number;       // >0 → any span in the trace errored
}

// Full span row — what /v1/traces/:traceId returns inside `spans[]` and `root`.
export interface SpanDetail {
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
}

export interface TraceDetail {
  traceId: string;
  root: SpanDetail;
  spans: SpanDetail[];
}

export interface Filter {
  field: string;
  op: Operator;
  value?: string | number | string[] | number[];
}

export interface SearchQuery {
  filters?: Filter[];
  from?: string;
  to?: string;
  limit?: number;
  orderBy?: "timestamp" | "duration_ms" | "cost_usd" | "input_tokens" | "output_tokens";
  orderDir?: "asc" | "desc";
  /** Time-cursor for pagination (ms epoch): return only traces older than this. */
  before?: number;
}

export interface DashboardData {
  intervalSec: number;
  window: { from: string; to: string };
  cost: { total: number; byModel: Array<{ model: string; cost: number }> };
  tokens: {
    input: number;
    output: number;
    byModel: Array<{ model: string; input: number; output: number }>;
  };
  latency: {
    p50: number;
    p95: number;
    p99: number;
    count: number;
    byOperation: Array<{ operation: string; p50: number; p95: number; count: number }>;
  };
  errors: { total: number; rate: number; sampleSize: number };
  throughput: { bucketed: Array<{ t: string; count: number }> };
  latencyHistogram: Array<{ bucket: string; count: number }>;
  trends: Array<{
    t: string;
    spans: number;
    cost: number;
    inputTokens: number;
    outputTokens: number;
    p95Ms: number;
    errors: number;
  }>;
}

async function getJSON<T>(path: string): Promise<T> {
  const r = await fetch(`/obs-api${path}`, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`${path} → ${r.status} ${await r.text().catch(() => "")}`);
  return r.json() as Promise<T>;
}
async function postJSON<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`/obs-api${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${path} → ${r.status} ${await r.text().catch(() => "")}`);
  return r.json() as Promise<T>;
}

export const obsApi = {
  health: () => getJSON<{ ok: boolean; clickhouse: "up" | "down" }>("/v1/health"),
  traces: (opts: { agent?: string; from?: string; to?: string; limit?: number } = {}) => {
    const params = new URLSearchParams();
    if (opts.agent) params.set("agent", opts.agent);
    if (opts.from) params.set("from", opts.from);
    if (opts.to) params.set("to", opts.to);
    if (opts.limit) params.set("limit", String(opts.limit));
    const qs = params.toString();
    return getJSON<{ traces: TraceSummary[] }>(`/v1/traces${qs ? `?${qs}` : ""}`).then((d) => d.traces);
  },
  search: (q: SearchQuery) =>
    postJSON<{ traces: TraceSummary[] }>(`/v1/traces/search`, q).then((d) => d.traces),
  trace: (traceId: string) =>
    getJSON<TraceDetail>(`/v1/traces/${encodeURIComponent(traceId)}`),
  dashboard: (opts: { agent?: string; from?: string; to?: string } = {}) => {
    const params = new URLSearchParams();
    if (opts.agent) params.set("agent", opts.agent);
    if (opts.from) params.set("from", opts.from);
    if (opts.to) params.set("to", opts.to);
    const qs = params.toString();
    return getJSON<DashboardData>(`/v1/dashboard${qs ? `?${qs}` : ""}`);
  },
  fieldValues: (name: string, limit?: number) => {
    const qs = limit ? `?limit=${limit}` : "";
    return getJSON<{
      values: Array<{ value: string; count: number; lastSeenMs: number }>;
      source?: "materialized" | "distinct-scan";
    }>(`/v1/fields/${encodeURIComponent(name)}/values${qs}`).then((d) => d.values);
  },
};
