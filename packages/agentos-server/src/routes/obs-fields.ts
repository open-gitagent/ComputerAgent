// Observability — field-discovery + per-field value autocomplete.
//
// `/v1/fields` is backend-agnostic — it returns the static FIELDS metadata.
// `/v1/fields/:name/values` dispatches to ClickHouse or NRQL based on
// TRACE_BACKEND. The NRQL path uses a live `uniques()` query with a
// 60-second in-memory cache to keep latency bounded.

import { Router, type Router as IRouter } from "express";
import { FIELDS } from "../fields.js";
import { queryRows as chQueryRows } from "../clickhouse.js";
import { queryRows as nrqlQueryRows } from "../new-relic.js";
import { traceBackend } from "../trace-backend.js";

export const obsFieldsRouter: IRouter = Router();

obsFieldsRouter.get("/fields", (_req, res) => {
  res.json({
    fields: Object.values(FIELDS).map((f) => ({
      key: f.key,
      label: f.label,
      type: f.type,
      ops: f.ops,
      enumValues: f.enumValues,
    })),
  });
});

type ValueRow = { value: string; count: number; lastSeenMs: number };

obsFieldsRouter.get("/fields/:name/values", async (req, res, next) => {
  try {
    const name = req.params["name"] ?? "";
    const def = FIELDS[name];
    if (!def) return res.status(404).json({ error: `unknown field: ${name}` });

    if (def.type === "number") {
      return res.json({ values: [] });
    }

    const limit = Math.max(
      1,
      Math.min(500, parseInt(String(req.query["limit"] ?? "50"), 10) || 50),
    );

    if (traceBackend() === "newrelic") {
      const values = await fetchValuesNrql(name, def.nrqlAttr, limit);
      return res.json({ values, source: "newrelic-uniques" as const });
    }

    const values = await fetchValuesClickhouse(name, def.sqlExpr, limit);
    res.json(values);
  } catch (err) {
    next(err);
  }
});

// ─── ClickHouse path (unchanged behavior) ─────────────────────────────────

type ClickhouseValueRow = { value: string; count: number; last_seen: string };

async function fetchValuesClickhouse(
  name: string,
  sqlExpr: string,
  limit: number,
): Promise<{
  values: ValueRow[];
  source: "materialized" | "distinct-scan";
}> {
  // Fast path — materialized view (created by migrations on boot).
  try {
    const rows = await chQueryRows<ClickhouseValueRow>(
      `SELECT value,
              countMerge(span_count)              AS count,
              toString(maxMerge(last_seen))       AS last_seen
       FROM otel_field_values
       WHERE field = {field:String} AND value != ''
       GROUP BY value
       ORDER BY count DESC, value ASC
       LIMIT {limit:UInt32}`,
      { field: name, limit },
    );
    return {
      values: rows.map((r) => ({
        value: r.value,
        count: Number(r.count),
        lastSeenMs: r.last_seen ? new Date(r.last_seen).getTime() : 0,
      })),
      source: "materialized" as const,
    };
  } catch (err) {
    console.warn(
      `[agentos-server] otel_field_values MV unavailable, falling back to DISTINCT for "${name}":`,
      (err as Error).message,
    );
  }

  const rows = await chQueryRows<{ v: string; c: number }>(
    `SELECT ${sqlExpr} AS v, count() AS c
     FROM otel_traces
     WHERE ${sqlExpr} != ''
     GROUP BY v
     ORDER BY c DESC, v ASC
     LIMIT {limit:UInt32}`,
    { limit },
  );
  return {
    values: rows.map((r) => ({
      value: r.v,
      count: Number(r.c),
      lastSeenMs: 0,
    })),
    source: "distinct-scan" as const,
  };
}

// ─── NRQL path with in-memory cache ───────────────────────────────────────
//
// NRQL has no materialized views, so we run `uniques()` live. To keep
// autocomplete responsive on heavily-loaded dashboards, results are cached
// in-process for 60 seconds per (field, limit) tuple.

interface CacheEntry {
  expiresAtMs: number;
  values: ValueRow[];
}
const CACHE_TTL_MS = 60 * 1000;
const cache = new Map<string, CacheEntry>();

async function fetchValuesNrql(
  fieldName: string,
  nrqlAttr: string,
  limit: number,
): Promise<ValueRow[]> {
  const key = `${fieldName}:${limit}`;
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && cached.expiresAtMs > now) return cached.values;

  // FACET on the attribute, count rows + capture the latest timestamp.
  // `LIMIT MAX` is bounded — we still cap to `limit` in code.
  //
  // NRQL: single-dim FACET auto-names its result column `facet`; the
  // `AS <alias>` syntax is illegal here so we rely on the default.
  const rows = await nrqlQueryRows<{ facet: string; count: number; last_seen?: number }>(
    `SELECT count(*) AS count, latest(timestamp) AS last_seen
     FROM Span
     WHERE \`${nrqlAttr}\` IS NOT NULL AND \`${nrqlAttr}\` != ''
     FACET \`${nrqlAttr}\`
     SINCE 24 hours ago
     LIMIT {limit:UInt32}`,
    { limit },
  );

  const values = rows.slice(0, limit).map((r) => ({
    value: r.facet,
    count: Number(r.count),
    lastSeenMs: typeof r.last_seen === "number" ? Number(r.last_seen) : 0,
  }));

  cache.set(key, { expiresAtMs: now + CACHE_TTL_MS, values });
  return values;
}

/** Test hook — clear the cache between tests. */
export function _clearFieldValuesCacheForTests(): void {
  cache.clear();
}
