import { Router, type Router as IRouter } from "express";
import { buildTraceListSql, type Filter } from "../query.js";
import { queryRows } from "../clickhouse.js";

export const tracesListRouter: IRouter = Router();

tracesListRouter.get("/traces", async (req, res, next) => {
  try {
    const agent = typeof req.query["agent"] === "string" ? req.query["agent"] : undefined;
    const from = typeof req.query["from"] === "string" ? req.query["from"] : undefined;
    const to = typeof req.query["to"] === "string" ? req.query["to"] : undefined;
    const limit = req.query["limit"] ? parseInt(String(req.query["limit"]), 10) : 100;

    const filters: Filter[] = [];
    if (agent) filters.push({ field: "agent", op: "eq", value: agent });

    const { sql, params } = buildTraceListSql({ filters, from, to, limit });
    const traces = await queryRows(sql, params);
    res.json({ traces });
  } catch (err) {
    next(err);
  }
});
