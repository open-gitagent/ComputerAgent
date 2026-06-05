// Observability trust boundary — read-only trace/dashboard/fields surface,
// mounted under /v1 (the SPA's obs client + external consumers hit this path,
// so /v1 stays stable). Public health first, then the gate.

import { Router, type Router as IRouter } from "express";
import { authenticate } from "../auth/authenticate.js";
import { resolvePermissions, authorize } from "../auth/authorize.js";

import { healthRouter } from "./health.js";
import { obsTracesRouter } from "./obs-traces.js";
import { obsDashboardRouter } from "./obs-dashboard.js";
import { obsFieldsRouter } from "./obs-fields.js";

export function mountObs(): IRouter {
  const r = Router();

  // PUBLIC — /v1/health, before the gate.
  r.use(healthRouter);

  // GATE — observability is read-only; the whole surface needs obs:read.
  r.use(authenticate);
  r.use(resolvePermissions);
  r.use(authorize("obs:read"));

  r.use(obsTracesRouter); //    /traces (search before list before :id)
  r.use(obsDashboardRouter); // /dashboard
  r.use(obsFieldsRouter); //    /fields, /fields/:name/values

  return r;
}
