import { Router, type Router as IRouter } from "express";
import { buildTraceListSql, type Query } from "../query.js";
import { queryRows } from "../clickhouse.js";

export const tracesSearchRouter: IRouter = Router();

tracesSearchRouter.post("/traces/search", async (req, res, next) => {
  try {
    const q = (req.body ?? {}) as Query;
    const { sql, params } = buildTraceListSql(q);
    const traces = await queryRows(sql, params);
    res.json({ traces });
  } catch (err) {
    next(err);
  }
});
