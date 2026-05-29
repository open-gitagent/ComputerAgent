// Observability — field-discovery + per-field value autocomplete.

import { Router, type Router as IRouter } from "express";
import { FIELDS } from "../fields.js";
import { queryRows } from "../clickhouse.js";

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

type ValueRow = { value: string; count: number; last_seen: string };

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

    // Fast path — materialized view (created by migrations on boot).
    try {
      const rows = await queryRows<ValueRow>(
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
      return res.json({
        values: rows.map((r) => ({
          value: r.value,
          count: Number(r.count),
          lastSeenMs: r.last_seen ? new Date(r.last_seen).getTime() : 0,
        })),
        source: "materialized" as const,
      });
    } catch (err) {
      console.warn(
        `[agentos-server] otel_field_values MV unavailable, falling back to DISTINCT for "${name}":`,
        (err as Error).message,
      );
    }

    const rows = await queryRows<{ v: string; c: number }>(
      `SELECT ${def.sqlExpr} AS v, count() AS c
       FROM otel_traces
       WHERE ${def.sqlExpr} != ''
       GROUP BY v
       ORDER BY c DESC, v ASC
       LIMIT {limit:UInt32}`,
      { limit },
    );
    res.json({
      values: rows.map((r) => ({
        value: r.v,
        count: Number(r.c),
        lastSeenMs: 0,
      })),
      source: "distinct-scan" as const,
    });
  } catch (err) {
    next(err);
  }
});
