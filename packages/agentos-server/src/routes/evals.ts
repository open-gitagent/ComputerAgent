// Evals — suite CRUD + run trigger + run readback. Suites define test cases +
// which scorers to apply; runs hold the scored results. The actual execution
// lives in eval-runner.ts (fire-and-forget; the UI polls GET /evals/runs/:id).

import { Router, type Router as IRouter } from "express";
import { randomUUID } from "node:crypto";

import { evalRunsColl, evalSuitesColl } from "../mongo.js";
import { startRun } from "../eval-runner.js";
import { generateCases } from "../eval-generate.js";
import type { EvalCase, EvalSuiteDoc, JudgeDef, ScorerConfig } from "../eval-types.js";
import { authorize } from "../auth/authorize.js";
import { canRead } from "../auth/ownership.js";
import { resolveAgent, listReadableAgentNames } from "../agent-defs.js";
import type { Principal } from "../auth/principal.js";

export const evalsRouter: IRouter = Router();

// Eval suites/runs key on agentName; visibility follows the target agent's
// group (hard isolation). Unknown agent (orphan suite) → allowed.
async function agentReadable(principal: Principal | undefined, agentName: string): Promise<boolean> {
  const a = await resolveAgent(agentName);
  return !a || canRead(principal, a);
}

const DEFAULT_SCORERS: ScorerConfig = { taskSuccess: true, toolCompliance: false, golden: false, nfr: false };

/** Coerce + default a suite body (used by create + update). */
function coerceSuiteBody(body: Record<string, unknown>): {
  name: string;
  description?: string;
  agentName: string;
  cases: EvalCase[];
  scorers: ScorerConfig;
  judges: JudgeDef[];
  passThreshold?: number;
} {
  const cases = Array.isArray(body["cases"])
    ? (body["cases"] as unknown[]).map((raw, i): EvalCase => {
        const c = (raw ?? {}) as Record<string, unknown>;
        return {
          id: typeof c["id"] === "string" && c["id"] ? (c["id"] as string) : `case-${i + 1}`,
          prompt: String(c["prompt"] ?? ""),
          ...(typeof c["criteria"] === "string" ? { criteria: c["criteria"] as string } : {}),
          ...(c["golden"] && typeof c["golden"] === "object" ? { golden: c["golden"] as EvalCase["golden"] } : {}),
          ...(Array.isArray(c["expectedTools"]) ? { expectedTools: (c["expectedTools"] as unknown[]).map(String) } : {}),
          ...(Array.isArray(c["forbiddenTools"]) ? { forbiddenTools: (c["forbiddenTools"] as unknown[]).map(String) } : {}),
          ...(typeof c["maxCostUsd"] === "number" ? { maxCostUsd: c["maxCostUsd"] as number } : {}),
          ...(typeof c["maxLatencyMs"] === "number" ? { maxLatencyMs: c["maxLatencyMs"] as number } : {}),
        };
      })
    : [];
  const sc = (body["scorers"] ?? {}) as Record<string, unknown>;
  const scorers: ScorerConfig = {
    taskSuccess: sc["taskSuccess"] !== undefined ? !!sc["taskSuccess"] : DEFAULT_SCORERS.taskSuccess,
    toolCompliance: !!sc["toolCompliance"],
    golden: !!sc["golden"],
    nfr: !!sc["nfr"],
  };
  return {
    name: String(body["name"] ?? "").trim(),
    ...(typeof body["description"] === "string" ? { description: body["description"] as string } : {}),
    agentName: String(body["agentName"] ?? "").trim(),
    cases,
    scorers,
    judges: coerceJudges(body["judges"]),
    ...(typeof body["passThreshold"] === "number" ? { passThreshold: body["passThreshold"] as number } : {}),
  };
}

function coerceJudges(raw: unknown): JudgeDef[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((r, i): JudgeDef => {
    const j = (r ?? {}) as Record<string, unknown>;
    return {
      id: typeof j["id"] === "string" && j["id"] ? (j["id"] as string) : `judge-${i + 1}`,
      name: typeof j["name"] === "string" && (j["name"] as string).trim() ? (j["name"] as string).trim() : `Judge ${i + 1}`,
      ...(typeof j["rubric"] === "string" && j["rubric"] ? { rubric: j["rubric"] as string } : {}),
      ...(typeof j["model"] === "string" && j["model"] ? { model: j["model"] as string } : {}),
      ...(typeof j["passThreshold"] === "number" ? { passThreshold: j["passThreshold"] as number } : {}),
    };
  });
}

// ── Suites ────────────────────────────────────────────────────────────────
evalsRouter.get("/evals/suites", authorize("evals:read"), async (_req, res, next) => {
  try {
    const suites = await (await evalSuitesColl()).find({}).sort({ updatedAt: -1 }).toArray();
    const { all, names } = await listReadableAgentNames(res.locals.principal);
    res.json({ suites: all ? suites : suites.filter((s) => names.has(s.agentName)) });
  } catch (err) {
    next(err);
  }
});

evalsRouter.get("/evals/suites/:id", authorize("evals:read"), async (req, res, next) => {
  try {
    const suite = await (await evalSuitesColl()).findOne({ _id: req.params["id"]! });
    if (!suite) return res.status(404).json({ error: { code: "NOT_FOUND" } });
    if (!(await agentReadable(res.locals.principal, suite.agentName))) return res.status(403).json({ error: { code: "NOT_OWNER" } });
    res.json(suite);
  } catch (err) {
    next(err);
  }
});

evalsRouter.post("/evals/suites", authorize("evals:write"), async (req, res, next) => {
  try {
    const fields = coerceSuiteBody((req.body ?? {}) as Record<string, unknown>);
    if (!fields.name) return res.status(400).json({ error: { code: "BAD_REQUEST", message: "`name` required" } });
    if (!fields.agentName) return res.status(400).json({ error: { code: "BAD_REQUEST", message: "`agentName` required" } });
    if (!(await agentReadable(res.locals.principal, fields.agentName))) return res.status(403).json({ error: { code: "NOT_OWNER" } });
    const now = new Date();
    const suite: EvalSuiteDoc = { _id: randomUUID(), ...fields, createdAt: now, updatedAt: now };
    await (await evalSuitesColl()).insertOne(suite);
    res.json(suite);
  } catch (err) {
    next(err);
  }
});

evalsRouter.put("/evals/suites/:id", authorize("evals:write"), async (req, res, next) => {
  try {
    const id = req.params["id"]!;
    const fields = coerceSuiteBody((req.body ?? {}) as Record<string, unknown>);
    if (!fields.name) return res.status(400).json({ error: { code: "BAD_REQUEST", message: "`name` required" } });
    const existing = await (await evalSuitesColl()).findOne({ _id: id });
    if (!existing) return res.status(404).json({ error: { code: "NOT_FOUND" } });
    if (!(await agentReadable(res.locals.principal, existing.agentName))) return res.status(403).json({ error: { code: "NOT_OWNER" } });
    const r = await (await evalSuitesColl()).updateOne(
      { _id: id },
      { $set: { ...fields, updatedAt: new Date() } },
    );
    if (r.matchedCount === 0) return res.status(404).json({ error: { code: "NOT_FOUND" } });
    const suite = await (await evalSuitesColl()).findOne({ _id: id });
    res.json(suite);
  } catch (err) {
    next(err);
  }
});

evalsRouter.delete("/evals/suites/:id", authorize("evals:write"), async (req, res, next) => {
  try {
    const id = req.params["id"]!;
    const existing = await (await evalSuitesColl()).findOne({ _id: id });
    if (!existing) return res.status(404).json({ error: { code: "NOT_FOUND" } });
    if (!(await agentReadable(res.locals.principal, existing.agentName))) return res.status(403).json({ error: { code: "NOT_OWNER" } });
    await (await evalSuitesColl()).deleteOne({ _id: id });
    await (await evalRunsColl()).deleteMany({ suiteId: id }); // cascade
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ── Case generation (probe the agent + LLM-synthesize cases) ───────────────
evalsRouter.post("/evals/generate", authorize("evals:write"), async (req, res, next) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const agentName = String(body["agentName"] ?? "").trim();
    if (!agentName) return res.status(400).json({ error: { code: "BAD_REQUEST", message: "`agentName` required" } });
    if (!(await agentReadable(res.locals.principal, agentName))) return res.status(403).json({ error: { code: "NOT_OWNER" } });
    const count = typeof body["count"] === "number" ? (body["count"] as number) : 5;
    const focus = typeof body["focus"] === "string" ? (body["focus"] as string) : undefined;
    const cases = await generateCases(agentName, count, focus);
    res.json({ cases });
  } catch (err) {
    res.status(502).json({ error: { code: "GENERATION_FAILED", message: (err as Error).message } });
  }
});

// ── Runs ──────────────────────────────────────────────────────────────────
evalsRouter.post("/evals/suites/:id/run", authorize("evals:write"), async (req, res, next) => {
  try {
    const suite = await (await evalSuitesColl()).findOne({ _id: req.params["id"]! });
    if (!suite) return res.status(404).json({ error: { code: "NOT_FOUND" } });
    if (!(await agentReadable(res.locals.principal, suite.agentName))) return res.status(403).json({ error: { code: "NOT_OWNER" } });
    if (!suite.cases.length) {
      return res.status(400).json({ error: { code: "EMPTY_SUITE", message: "suite has no cases" } });
    }
    const runId = await startRun(suite);
    res.json({ runId });
  } catch (err) {
    next(err);
  }
});

evalsRouter.get("/evals/runs", authorize("evals:read"), async (req, res, next) => {
  try {
    const suite = typeof req.query["suite"] === "string" ? (req.query["suite"] as string) : undefined;
    const filter = suite ? { suiteId: suite } : {};
    const runs = await (await evalRunsColl()).find(filter).sort({ startedAt: -1 }).limit(50).toArray();
    const { all, names } = await listReadableAgentNames(res.locals.principal);
    res.json({ runs: all ? runs : runs.filter((r) => names.has(r.agentName)) });
  } catch (err) {
    next(err);
  }
});

evalsRouter.get("/evals/runs/:id", authorize("evals:read"), async (req, res, next) => {
  try {
    const run = await (await evalRunsColl()).findOne({ _id: req.params["id"]! });
    if (!run) return res.status(404).json({ error: { code: "NOT_FOUND" } });
    if (!(await agentReadable(res.locals.principal, run.agentName))) return res.status(403).json({ error: { code: "NOT_OWNER" } });
    res.json(run);
  } catch (err) {
    next(err);
  }
});
