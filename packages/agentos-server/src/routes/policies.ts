// Policies tab — SRS (Security/Runtime/Safety) proxy. SRS isn't deployed
// here, so every endpoint returns empty list / 404 / 503 so the UI's empty
// states render cleanly instead of erroring out. When SRS lands, replace
// these handlers with reverse-proxy calls.

import { Router, type Router as IRouter } from "express";

export const policiesRouter: IRouter = Router();

policiesRouter.get("/policies", (_req, res) => res.json({ policies: [] }));
policiesRouter.get("/policies/:id", (_req, res) =>
  res.status(404).json({ error: { code: "NOT_FOUND" } }),
);
policiesRouter.post("/policies", (_req, res) =>
  res.status(503).json({
    error: { code: "SRS_NOT_CONFIGURED", message: "Policy service (SRS) is not deployed in this environment." },
  }),
);
policiesRouter.put("/policies/:id", (_req, res) =>
  res.status(503).json({ error: { code: "SRS_NOT_CONFIGURED" } }),
);
policiesRouter.delete("/policies/:id", (_req, res) =>
  res.status(503).json({ error: { code: "SRS_NOT_CONFIGURED" } }),
);

policiesRouter.get("/agents/:name/policy", (_req, res) => res.json({ binding: null }));
policiesRouter.put("/agents/:name/policy", (_req, res) => res.json({ binding: null }));

policiesRouter.get("/opa-policies", (_req, res) => res.json({ policies: [] }));
policiesRouter.get("/opa-policies/:id", (_req, res) =>
  res.status(404).json({ error: { code: "NOT_FOUND" } }),
);
policiesRouter.post("/opa-policies", (_req, res) =>
  res.status(503).json({ error: { code: "SRS_NOT_CONFIGURED" } }),
);
policiesRouter.put("/opa-policies/:id", (_req, res) =>
  res.status(503).json({ error: { code: "SRS_NOT_CONFIGURED" } }),
);
policiesRouter.delete("/opa-policies/:id", (_req, res) =>
  res.status(503).json({ error: { code: "SRS_NOT_CONFIGURED" } }),
);
