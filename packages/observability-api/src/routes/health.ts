import { Router, type Router as IRouter } from "express";
import { pingClickHouse } from "../clickhouse.js";

export const healthRouter: IRouter = Router();

healthRouter.get("/health", async (_req, res) => {
  const ok = await pingClickHouse();
  res.json({ ok, clickhouse: ok ? "up" : "down" });
});
