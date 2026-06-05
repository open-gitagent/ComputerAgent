// The single authentication gate. Resolves a Principal (set on
// res.locals.principal) from, in priority order:
//   1. Authorization: Bearer cak_…   → API key  → service principal
//   2. Authorization: Bearer <jwt>    → OIDC      → user principal (verified via JWKS)
//   3. agentos_session cookie         → BFF       → user principal (snapshot)
//   4. AGENTOS_DEV_AUTH=1 (local only) → admin principal (no Keycloak needed)
// Otherwise 401 UNAUTHENTICATED. `permissions` is left empty here and filled by
// resolvePermissions downstream from the DB role map.

import type { RequestHandler } from "express";
import { SESSION_COOKIE, verifySessionSnapshot } from "../auth.js";
import { apiKeyStore, KEY_PREFIX } from "../stores/api-key-store.js";
import { verifyAccessToken, claimsToPrincipal, oidcConfigured } from "./oidc.js";
import type { Principal } from "./principal.js";

const unauth = (res: Parameters<RequestHandler>[1]) =>
  res.status(401).json({ error: { code: "UNAUTHENTICATED" } });

function devEnabled(): boolean {
  return process.env["AGENTOS_DEV_AUTH"] === "1";
}

function devPrincipal(): Principal {
  return {
    id: "dev",
    kind: "user",
    email: "dev@local",
    displayName: "Dev (AGENTOS_DEV_AUTH)",
    roles: ["agentos-admin"],
    groups: ["agentos-admins"],
    permissions: ["*"],
    source: "dev",
  };
}

export const authenticate: RequestHandler = (req, res, next) => {
  void (async () => {
    try {
      const header = req.header("authorization") ?? "";

      if (header.startsWith("Bearer ")) {
        const token = header.slice("Bearer ".length).trim();

        // 1. API key.
        if (token.startsWith(KEY_PREFIX)) {
          const result = await apiKeyStore.verify(token);
          if (!result) return unauth(res);
          res.locals.principal = {
            id: result.principal,
            kind: "service",
            roles: result.roleIds,
            groups: result.group ? [result.group] : [],
            permissions: [],
            source: "api-key",
          };
          res.locals.user = result.principal;
          return next();
        }

        // 2. OIDC access token.
        if (oidcConfigured()) {
          try {
            const principal = claimsToPrincipal(await verifyAccessToken(token));
            res.locals.principal = principal;
            res.locals.user = principal.email ?? principal.id;
            return next();
          } catch {
            return unauth(res);
          }
        }
        return unauth(res);
      }

      // 3. BFF session cookie.
      const cookie = req.cookies?.[SESSION_COOKIE];
      if (typeof cookie === "string" && cookie.length > 0) {
        const snap = verifySessionSnapshot(cookie);
        if (snap) {
          res.locals.principal = {
            id: snap.sub,
            kind: "user",
            email: snap.email,
            displayName: snap.name,
            roles: snap.roles,
            groups: snap.groups,
            permissions: [],
            source: "cookie",
          };
          res.locals.user = snap.email ?? snap.sub;
          return next();
        }
      }

      // 4. Local dev bypass.
      if (devEnabled()) {
        const principal = devPrincipal();
        res.locals.principal = principal;
        res.locals.user = principal.email;
        return next();
      }

      unauth(res);
    } catch (err) {
      next(err);
    }
  })();
};
