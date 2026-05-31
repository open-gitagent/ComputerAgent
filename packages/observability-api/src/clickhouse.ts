import { createClient, type ClickHouseClient } from "@clickhouse/client";

let _client: ClickHouseClient | null = null;

export function getClient(): ClickHouseClient {
  if (_client) return _client;
  const url = process.env["CLICKHOUSE_URL"] ?? "http://localhost:8123";
  const username = process.env["CLICKHOUSE_USER"] ?? "default";
  const password = process.env["CLICKHOUSE_PASSWORD"] ?? "";
  const database = process.env["CLICKHOUSE_DATABASE"] ?? "otel";
  _client = createClient({
    url,
    username,
    password,
    database,
    max_open_connections: 10,
    compression: { response: true, request: false },
    // ts_ms is Int64 (toUnixTimestamp64Milli). Default JSON output quotes
    // 64-bit ints as strings; turn that off — ms timestamps fit in JS Number.
    clickhouse_settings: {
      output_format_json_quote_64bit_integers: 0,
    },
  });
  return _client;
}

export async function pingClickHouse(): Promise<boolean> {
  try {
    const r = await getClient().ping();
    return r.success;
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

export async function queryRows<T>(sql: string, params?: Record<string, unknown>): Promise<T[]> {
  return withRetry(async () => {
    const rs = await getClient().query({
      query: sql,
      query_params: params ?? {},
      format: "JSONEachRow",
    });
    return (await rs.json()) as T[];
  });
}

export async function queryOne<T>(sql: string, params?: Record<string, unknown>): Promise<T | null> {
  const rows = await queryRows<T>(sql, params);
  return rows[0] ?? null;
}
