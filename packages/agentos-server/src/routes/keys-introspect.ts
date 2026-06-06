// API-key introspection (RFC 7662 style). The ComputerAgent server POSTs a
// presented key here to learn whether it is active. Gated by the service secret
// (requireIntrospectionAuth, mounted before this router). Response is minimal
// and NEVER echoes the submitted key.

import { Router, type Router as IRouter } from "express";
import { apiKeyStore } from "../stores/api-key-store.js";
import { resolveEffectivePermissions } from "../auth/authorize.js";

export const keysIntrospectRouter: IRouter = Router();

keysIntrospectRouter.post("/keys/introspect", async (req, res, next) => {
  try {
    const key = (req.body as { key?: unknown } | undefined)?.key;
    if (typeof key !== "string" || !key) {
      return res.json({ active: false }); // no info leak; still 200
    }
    const result = await apiKeyStore.verify(key);
    if (!result) return res.json({ active: false });
    // Resolve the key's roleIds to the SAME effective permissions the dashboard
    // uses, so the ComputerAgent server can enforce capability (e.g. agents:run)
    // without ever holding the role→permission map. `["*"]` = admin.
    const permissions = await resolveEffectivePermissions(result.roleIds);
    res.json({
      active: true,
      principal: result.principal,
      roleIds: result.roleIds,
      permissions, // resolved capability set — the CAS gates routes on this
      group: result.group ?? null,
      scopes: result.scopes, // DEPRECATED — back-compat for existing CAS verifier
      ...(result.expiresAt ? { exp: Math.floor(result.expiresAt.getTime() / 1000) } : {}),
    });
  } catch (err) {
    next(err);
  }
});
