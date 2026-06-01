// NerdGraph-backed trace adapter — mirrors the surface of clickhouse.ts so
// the obs-* routes can switch backends with minimal diffs.
//
// New Relic exposes NRQL via NerdGraph (GraphQL). For each call:
//   1. Substitute the typed `{name:Type}` placeholders client-side (NRQL itself
//      has no parameterized-query support; we escape values to avoid injection).
//   2. Wrap the resulting NRQL in a NerdGraph query:
//        actor { account(id: $accountId) { nrql(query: "...") { results } } }
//   3. POST to https://api.newrelic.com/graphql (or api.eu.newrelic.com).
//   4. Return `results` as the same row-shape ClickHouse returned.
//
// Configuration env vars (all required when TRACE_BACKEND=newrelic):
//   NEW_RELIC_USER_API_KEY  — read-only User API Key
//   NEW_RELIC_ACCOUNT_ID    — numeric account ID
//   NEW_RELIC_REGION        — "US" or "EU" (default "US")
//
// The User API Key is DIFFERENT from the ingest license key used by the
// otel-collector — that's a write-only key, this one is read-only.

const US_ENDPOINT = "https://api.newrelic.com/graphql";
const EU_ENDPOINT = "https://api.eu.newrelic.com/graphql";

function endpoint(): string {
  const region = (process.env["NEW_RELIC_REGION"] ?? "US").toUpperCase();
  return region === "EU" ? EU_ENDPOINT : US_ENDPOINT;
}

function userApiKey(): string {
  const k = process.env["NEW_RELIC_USER_API_KEY"];
  if (!k) throw new Error("NEW_RELIC_USER_API_KEY env var is required");
  return k;
}

function accountId(): number {
  const raw = process.env["NEW_RELIC_ACCOUNT_ID"];
  if (!raw) throw new Error("NEW_RELIC_ACCOUNT_ID env var is required");
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`NEW_RELIC_ACCOUNT_ID must be a positive integer (got ${raw})`);
  }
  return n;
}

/**
 * Health check — issues a trivial NRQL query against the configured account.
 * Returns false on any error so callers can fall back gracefully.
 */
export async function pingNewRelic(): Promise<boolean> {
  try {
    await queryRows<{ one: number }>("SELECT 1 AS one FROM Span LIMIT 1");
    return true;
  } catch {
    return false;
  }
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function withRetry<T>(fn: () => Promise<T>, retries = 2, backoffMs = 250): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i < retries) await sleep(backoffMs * Math.pow(2, i));
    }
  }
  throw lastErr;
}

// ─────────────────────────────────────────────────────────────────────────────
// NRQL parameter substitution — mirrors the {name:Type} placeholder shape used
// by the ClickHouse client so callers can keep the same surface.
// ─────────────────────────────────────────────────────────────────────────────

/** NRQL placeholder syntax: `{paramName:Type}` — Type is one of the values
 *  in NRQL_PARAM_TYPES below. The substituted form is properly escaped for
 *  inclusion directly in an NRQL string literal.
 */
const PARAM_RE = /\{([a-zA-Z_][a-zA-Z0-9_]*):(String|UInt32|Int32|Float64|Array\((String|UInt32|Int32|Float64)\)|Timestamp)\}/g;

const NRQL_PARAM_TYPES = [
  "String",
  "UInt32",
  "Int32",
  "Float64",
  "Timestamp",
  "Array(String)",
  "Array(UInt32)",
  "Array(Int32)",
  "Array(Float64)",
] as const;
type NrqlParamType = (typeof NRQL_PARAM_TYPES)[number];

function nrqlEscapeString(s: string): string {
  // NRQL string literals use single quotes; escape single quotes by doubling.
  return `'${s.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
}

function nrqlFormatNumber(n: number, kind: "UInt32" | "Int32" | "Float64"): string {
  if (!Number.isFinite(n)) throw new Error(`non-finite number for ${kind}: ${n}`);
  if (kind !== "Float64" && !Number.isInteger(n)) {
    throw new Error(`integer expected for ${kind}, got ${n}`);
  }
  if (kind === "UInt32" && n < 0) {
    throw new Error(`unsigned integer expected for ${kind}, got ${n}`);
  }
  return String(n);
}

function nrqlFormatTimestamp(v: unknown): string {
  // Accept Date / number (ms since epoch) / ISO string. NRQL accepts ISO 8601.
  if (v instanceof Date) return nrqlEscapeString(v.toISOString());
  if (typeof v === "number" && Number.isFinite(v)) {
    return nrqlEscapeString(new Date(v).toISOString());
  }
  if (typeof v === "string") return nrqlEscapeString(v);
  throw new Error(`Timestamp param must be Date | number | string, got ${typeof v}`);
}

function nrqlFormatValue(value: unknown, type: NrqlParamType): string {
  if (type === "String") {
    if (typeof value !== "string") throw new Error(`String param expected string, got ${typeof value}`);
    return nrqlEscapeString(value);
  }
  if (type === "UInt32" || type === "Int32" || type === "Float64") {
    if (typeof value !== "number") throw new Error(`${type} param expected number, got ${typeof value}`);
    return nrqlFormatNumber(value, type);
  }
  if (type === "Timestamp") {
    return nrqlFormatTimestamp(value);
  }
  // Array(T)
  if (!Array.isArray(value)) throw new Error(`${type} param expected array`);
  const inner = type.slice(6, -1) as NrqlParamType; // "Array(String)" → "String"
  const parts = value.map((v) => nrqlFormatValue(v, inner));
  return `(${parts.join(", ")})`;
}

/** Substitute `{name:Type}` placeholders in an NRQL template. */
export function renderNrql(template: string, params: Record<string, unknown> = {}): string {
  return template.replace(PARAM_RE, (match, name: string, type: string) => {
    if (!(name in params)) throw new Error(`missing NRQL param: ${name}`);
    return nrqlFormatValue(params[name], type as NrqlParamType);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// NerdGraph client
// ─────────────────────────────────────────────────────────────────────────────

interface NerdGraphResponse {
  readonly data?: {
    readonly actor?: {
      readonly account?: {
        readonly nrql?: {
          readonly results?: ReadonlyArray<Record<string, unknown>>;
        };
      };
    };
  };
  readonly errors?: ReadonlyArray<{ readonly message?: string }>;
}

const NERDGRAPH_QUERY = /* GraphQL */ `
  query ($accountId: Int!, $nrql: Nrql!) {
    actor {
      account(id: $accountId) {
        nrql(query: $nrql) {
          results
        }
      }
    }
  }
`;

async function runNrql<T>(nrql: string): Promise<T[]> {
  const body = JSON.stringify({
    query: NERDGRAPH_QUERY,
    variables: { accountId: accountId(), nrql },
  });
  const res = await fetch(endpoint(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "API-Key": userApiKey(),
    },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`NerdGraph HTTP ${res.status}: ${text.slice(0, 500)}`);
  }
  const json = (await res.json()) as NerdGraphResponse;
  if (json.errors && json.errors.length > 0) {
    const msgs = json.errors.map((e) => e.message ?? "?").join("; ");
    throw new Error(`NerdGraph errors: ${msgs}`);
  }
  const results = json.data?.actor?.account?.nrql?.results;
  if (!Array.isArray(results)) {
    throw new Error("NerdGraph response missing nrql.results");
  }
  return results as T[];
}

/** Execute an NRQL query and return all result rows. Surface matches clickhouse.queryRows. */
export async function queryRows<T>(nrql: string, params?: Record<string, unknown>): Promise<T[]> {
  const rendered = renderNrql(nrql, params);
  return withRetry(() => runNrql<T>(rendered));
}

/** Execute an NRQL query and return the first row (or null). Surface matches clickhouse.queryOne. */
export async function queryOne<T>(nrql: string, params?: Record<string, unknown>): Promise<T | null> {
  const rows = await queryRows<T>(nrql, params);
  return rows[0] ?? null;
}
