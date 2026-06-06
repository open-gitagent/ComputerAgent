// Authorization layer — runs after the gate.
//
//   resolvePermissions  fills res.locals.principal.permissions from the DB role
//                        map (so editing a role propagates to users + keys).
//   authorize(perm)     per-route guard: passes if the principal holds `perm`
//                        (or the "*" wildcard), else 403 INSUFFICIENT_PERMISSION.
//
// Stage-2 bridge: the gate is still `requireAuth`, which sets res.locals.user
// (a string) but no principal. Until OIDC lands (Stage 3) we synthesize an
// admin principal from that shared-credential user, so the single operator
// keeps full access while the authorize() gates are wired in everywhere.

import type { RequestHandler } from "express";
import { roleStore } from "../stores/role-store.js";
import { forbidden, unauthorized } from "../http/errors.js";
import { WILDCARD } from "./permissions.js";
import type { Principal } from "./principal.js";

/** Emails (or subs) in AGENTOS_BOOTSTRAP_ADMINS always resolve to full access.
 *  Solves the first-admin problem: lets a freshly-logged-in Keycloak user
 *  administer the dashboard before any Keycloak roles are mapped to AgentOS
 *  roles. Keep this list tiny (the people who set up roles), then remove it. */
function isBootstrapAdmin(p: Principal): boolean {
  const raw = process.env["AGENTOS_BOOTSTRAP_ADMINS"];
  if (!raw) return false;
  const allow = raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!allow.length) return false;
  return [p.email, p.id].some((v) => !!v && allow.includes(v.toLowerCase()));
}

function legacyAdminPrincipal(user: string): Principal {
  return {
    id: user,
    kind: "user",
    roles: ["agentos-admin"],
    groups: [],
    permissions: [WILDCARD],
    source: "cookie",
  };
}

/** Resolve the principal's effective permission keys onto res.locals.principal. */
export const resolvePermissions: RequestHandler = (_req, res, next) => {
  let p = res.locals.principal;
  if (!p && res.locals.user) p = legacyAdminPrincipal(res.locals.user);
  if (!p) return next(unauthorized());

  // Bootstrap admins always get full access (before Keycloak roles are mapped).
  if (isBootstrapAdmin(p)) {
    res.locals.principal = { ...p, permissions: ["*"] };
    return next();
  }

  // Already resolved (legacy admin / dev bypass set ["*"], or a prior pass).
  if (p.permissions && p.permissions.length > 0) {
    res.locals.principal = p;
    return next();
  }
  const principal = p;
  resolveEffectivePermissions(principal.roles)
    .then((perms) => {
      res.locals.principal = { ...principal, permissions: perms };
      next();
    })
    .catch(next);
};

/**
 * Effective permissions = union over the principal's AgentOS roles. When that is
 * empty (the token carried no role that maps to an AgentOS role) and
 * AGENTOS_DEFAULT_ROLE is set, fall back to that role's permissions so any
 * authenticated user has a baseline (e.g. agentos-viewer). Unset → deny-by-default.
 *
 * Exported so the key-introspection endpoint resolves an API key's `roleIds`
 * to the SAME effective permission set the dashboard uses — keeping the role map
 * server-side (the CAS receives resolved permissions, never the raw role map).
 */
export async function resolveEffectivePermissions(roles: string[]): Promise<string[]> {
  const perms = await roleStore.permissionsFor(roles);
  if (perms.length > 0) return perms;
  const fallback = process.env["AGENTOS_DEFAULT_ROLE"];
  if (fallback) return roleStore.permissionsFor([fallback]);
  return perms; // [] → deny-by-default
}

/** Gate a route on a single permission key. */
export const authorize =
  (perm: string): RequestHandler =>
  (_req, res, next) => {
    const p = res.locals.principal;
    if (!p) return next(unauthorized());
    if (p.permissions.includes(WILDCARD) || p.permissions.includes(perm)) return next();
    next(forbidden("INSUFFICIENT_PERMISSION", `requires ${perm}`));
  };

/** Does the current principal hold a permission? (for handler-internal checks) */
export function principalHas(res: { locals: { principal?: Principal } }, perm: string): boolean {
  const p = res.locals.principal;
  return !!p && (p.permissions.includes(WILDCARD) || p.permissions.includes(perm));
}
