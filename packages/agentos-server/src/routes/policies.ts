// Policies tab — SRS (Security/Runtime/Safety) reverse-proxy.
//
// RAI policies (/policies) and OPA rego policies (/opa-policies) are proxied
// verbatim to SRS, injecting the x-api-key. SRS owns storage + evaluation;
// the SPA was built against SRS's native shapes (_id, cedar_guardrail,
// opa_guardrail), so we relay status + body unchanged.
//
// The per-agent policy *binding* (/agents/:name/policy) is ours, not SRS's —
// it records which RAI policy_id an agent enforces, stored in Mongo. The
// harness reads it (via the run body's `policy` field) and calls SRS's
// /v1/guardrails/evaluate-tool-call per tool call.
//
// If SRS_BASE_URL is unset the proxy routes return 503 SRS_NOT_CONFIGURED so
// the UI's empty states still render.

import { Router, type Router as IRouter, type Response } from "express";
import { getDb } from "../mongo.js";

export const policiesRouter: IRouter = Router();

const SRS_BASE = (process.env["SRS_BASE_URL"] ?? "").replace(/\/+$/, "");
const SRS_KEY = process.env["SRS_API_KEY"] ?? "";

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

/**
 * Forward a request to SRS, inject x-api-key, relay status + JSON body.
 *
 * `opts.fallback` (used for list GETs): when SRS is unset/unreachable/5xx,
 * respond 200 with the fallback instead of an error, so the Policies page
 * renders its empty state cleanly rather than surfacing "/policies → 502".
 * Writes pass no fallback, so create/update/delete still surface the error.
 */
async function srs(
  res: Response,
  method: string,
  path: string,
  opts: { body?: unknown; fallback?: unknown } = {},
): Promise<void> {
  const { body, fallback } = opts;
  if (!SRS_BASE) {
    if (fallback !== undefined) {
      res.json(fallback);
      return;
    }
    res.status(503).json({
      error: { code: "SRS_NOT_CONFIGURED", message: "Policy service (SRS) is not configured. Set SRS_BASE_URL." },
    });
    return;
  }
  try {
    const r = await fetch(`${SRS_BASE}${path}`, {
      method,
      headers: {
        "x-api-key": SRS_KEY,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (fallback !== undefined && r.status >= 500) {
      res.json(fallback);
      return;
    }
    const text = await r.text();
    res.status(r.status).json(text ? safeParse(text) : {});
  } catch (err) {
    if (fallback !== undefined) {
      res.json(fallback);
      return;
    }
    res.status(502).json({ error: { code: "SRS_UNREACHABLE", message: (err as Error).message } });
  }
}

// ── RAI policies → SRS /v1/rai/policies ───────────────────────────────────
policiesRouter.get("/policies", (_req, res) =>
  srs(res, "GET", "/v1/rai/policies", { fallback: { policies: [] } }),
);
policiesRouter.get("/policies/:id", (req, res) =>
  srs(res, "GET", `/v1/rai/policies/${encodeURIComponent(req.params["id"]!)}`),
);
policiesRouter.post("/policies", (req, res) => srs(res, "POST", "/v1/rai/policies", { body: req.body ?? {} }));
policiesRouter.put("/policies/:id", (req, res) =>
  srs(res, "PUT", `/v1/rai/policies/${encodeURIComponent(req.params["id"]!)}`, { body: req.body ?? {} }),
);
policiesRouter.delete("/policies/:id", (req, res) =>
  srs(res, "DELETE", `/v1/rai/policies/${encodeURIComponent(req.params["id"]!)}`),
);

// ── OPA rego policies → SRS /v1/opa-policies ──────────────────────────────
policiesRouter.get("/opa-policies", (_req, res) =>
  srs(res, "GET", "/v1/opa-policies", { fallback: { policies: [] } }),
);
policiesRouter.get("/opa-policies/:id", (req, res) =>
  srs(res, "GET", `/v1/opa-policies/${encodeURIComponent(req.params["id"]!)}`),
);
policiesRouter.post("/opa-policies", (req, res) => srs(res, "POST", "/v1/opa-policies", { body: req.body ?? {} }));
policiesRouter.put("/opa-policies/:id", (req, res) =>
  srs(res, "PUT", `/v1/opa-policies/${encodeURIComponent(req.params["id"]!)}`, { body: req.body ?? {} }),
);
policiesRouter.delete("/opa-policies/:id", (req, res) =>
  srs(res, "DELETE", `/v1/opa-policies/${encodeURIComponent(req.params["id"]!)}`),
);

// ── Per-agent policy binding (agentos-local, Mongo) ───────────────────────
interface PolicyBindingDoc {
  _id: string; // agent name
  policyId: string;
  updatedAt: Date;
}

async function bindingsColl() {
  return (await getDb()).collection<PolicyBindingDoc>("agent_policies");
}

policiesRouter.get("/agents/:name/policy", async (req, res, next) => {
  try {
    const doc = await (await bindingsColl()).findOne({ _id: req.params["name"]! });
    res.json({ binding: doc ? { policyId: doc.policyId } : null });
  } catch (err) {
    next(err);
  }
});

policiesRouter.put("/agents/:name/policy", async (req, res, next) => {
  try {
    const name = req.params["name"]!;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const policyId = typeof body["policy_id"] === "string" ? (body["policy_id"] as string) : null;
    const coll = await bindingsColl();
    if (!policyId) {
      await coll.deleteOne({ _id: name });
      res.json({ binding: null });
      return;
    }
    await coll.updateOne({ _id: name }, { $set: { policyId, updatedAt: new Date() } }, { upsert: true });
    res.json({ binding: { policyId } });
  } catch (err) {
    next(err);
  }
});
