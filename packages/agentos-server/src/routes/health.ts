// Combined health endpoint — reports both backends.
//   GET /agentos/api/health  → { ok, mongo, clickhouse }
//   GET /v1/health           → same payload (for obs-api compatibility)

import { Router, type Router as IRouter } from "express";
import { pingMongo } from "../mongo.js";
import { pingClickHouse } from "../clickhouse.js";

export const healthRouter: IRouter = Router();

healthRouter.get("/health", async (_req, res) => {
  const [mongoOk, chOk] = await Promise.all([pingMongo(), pingClickHouse()]);
  res.json({
    ok: mongoOk && chOk,
    mongo: mongoOk ? "up" : "down",
    clickhouse: chOk ? "up" : "down",
  });
});
