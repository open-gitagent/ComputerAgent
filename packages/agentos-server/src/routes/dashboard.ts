// Dashboard trust boundary — the browser/API surface, mounted under
// /agentos/api/v1. Public auth + health first, then the gate, then every
// resource router. Each resource router still declares its own resource path
// (`/agents`, `/sessions`, …); they are composed here so the gate + (Stage 2)
// authorization attach in one place.
//
// The gate is `requireAuth` today; Stage 3 swaps it for the unified
// `authenticate` (OIDC / API key / BFF cookie) without changing this shape.

import { Router, type Router as IRouter } from "express";
import { authenticate } from "../auth/authenticate.js";
import { resolvePermissions } from "../auth/authorize.js";

import { authRouter } from "./auth.js";
import { healthRouter } from "./health.js";
import { agentsRouter } from "./agents.js";
import { logsRouter } from "./logs.js";
import { sessionsRouter } from "./sessions.js";
import { schedulesRouter } from "./schedules.js";
import { apiKeysRouter } from "./api-keys.js";
import { gitCredentialsRouter } from "./git-credentials.js";
import { rolesRouter } from "./roles.js";
import { groupsRouter } from "./groups.js";
import { chatRouter } from "./chat.js";
import { runRouter } from "./run.js";
import { completionRouter } from "./completion.js";
import { messagesRouter } from "./messages.js";
import { policiesRouter } from "./policies.js";
import { evalsRouter } from "./evals.js";

export function mountDashboard(): IRouter {
  const r = Router();

  // PUBLIC — login/logout/me + health, before the gate.
  r.use(authRouter);
  r.use(healthRouter);

  // GATE — authenticate (OIDC / API key / BFF cookie), then resolve the
  // principal's effective permissions so per-route authorize(perm) can check them.
  r.use(authenticate);
  r.use(resolvePermissions);

  // Resource surface. Agent-scoped sub-resources (chat/run/policy) live in
  // their own routers but share the `/agents/:id/...` namespace. Each route
  // declares its required permission via authorize(perm) inside the router.
  r.use(agentsRouter); // /agents, /agents/:id, /agents/:id/{archive,unarchive}
  r.use(chatRouter); //    /agents/:id/chat-sandbox, /agents/:id/chat-pin, /sandboxes/:id/{chat,artifact}
  r.use(runRouter); //     /agents/:id/run
  r.use(policiesRouter); //  /policies, /opa-policies, /agents/:id/policy
  r.use(sessionsRouter); //  /sessions
  r.use(schedulesRouter); // /schedules
  r.use(logsRouter); //      /logs
  r.use(completionRouter); ///completion
  r.use(messagesRouter); //  /messages — Anthropic-compat model gateway (cak_-authed)
  r.use(evalsRouter); //     /evals/*
  r.use(apiKeysRouter); //   /api-keys
  r.use(gitCredentialsRouter); // /git-credentials, /git-credentials/resolve
  r.use(rolesRouter); //     /roles, /permissions
  r.use(groupsRouter); //    /groups, /groups/:id/members (read-only, from Keycloak)

  return r;
}
