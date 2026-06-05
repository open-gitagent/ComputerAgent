// API-key management — mint / list / revoke. Gated by `keys:read` (list) and
// `keys:manage` (mint/revoke). The minted plaintext is returned exactly ONCE.
//
// A key carries two ORTHOGONAL things (kept distinct on purpose):
//   - roleIds : CAPABILITY — the roles the key acts with → resolved to
//               permissions via the DB role map. (Roles, not groups: AgentOS
//               only knows role→permission; group→role lives in Keycloak.)
//   - group   : TENANCY — the group the key belongs to → ownership/visibility.
//
// Least-privilege escalation guard: a non-admin may only grant roles they
// themselves hold and a group they belong to. Admins (`roles:manage`) may grant
// any role / group.

import { Router, type Router as IRouter } from "express";
import { apiKeyStore } from "../stores/api-key-store.js";
import { authorize, principalHas } from "../auth/authorize.js";
import { canRead } from "../auth/ownership.js";

export const apiKeysRouter: IRouter = Router();

// POST /api-keys  { label, group?, roleIds?, expiresAt? } → 201 { key, apiKey }
// `key` (plaintext) appears ONLY in this response.
apiKeysRouter.post("/api-keys", authorize("keys:manage"), async (req, res, next) => {
  try {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const label = typeof b["label"] === "string" ? b["label"].trim() : "";
    if (!label) return res.status(400).json({ error: { code: "MISSING_LABEL" } });

    const principal = res.locals.principal;
    const isAdmin = principalHas(res, "roles:manage");

    // CAPABILITY — roles the key acts with (resolved to permissions). Required.
    // Non-admins may only grant roles they themselves hold (no escalation).
    const roleIds = Array.isArray(b["roleIds"]) ? (b["roleIds"] as unknown[]).map(String).filter(Boolean) : [];
    if (roleIds.length === 0) {
      return res.status(400).json({ error: { code: "MISSING_ROLE", message: "`roleIds` (at least one role) is required" } });
    }
    if (!isAdmin) {
      const own = new Set(principal?.roles ?? []);
      const denied = roleIds.filter((r) => !own.has(r));
      if (denied.length) {
        return res.status(403).json({
          error: { code: "ROLE_NOT_GRANTED", message: `you do not hold role(s): ${denied.join(", ")}` },
        });
      }
    }

    // TENANCY — the group the key belongs to (optional). Non-admins may only
    // bind it to a group they belong to.
    let group: string | null = null;
    if (typeof b["group"] === "string" && b["group"].trim()) {
      group = b["group"].trim();
      if (!isAdmin && !(principal?.groups ?? []).includes(group)) {
        return res.status(403).json({ error: { code: "GROUP_NOT_ALLOWED", message: `not a member of group: ${group}` } });
      }
    }

    let expiresAt: Date | null = null;
    if (b["expiresAt"] !== undefined && b["expiresAt"] !== null && b["expiresAt"] !== "") {
      const raw = b["expiresAt"];
      const d = typeof raw === "string" || typeof raw === "number" ? new Date(raw) : new Date(NaN);
      if (Number.isNaN(d.getTime())) return res.status(400).json({ error: { code: "BAD_EXPIRY" } });
      expiresAt = d;
    }

    const created = await apiKeyStore.create({
      label,
      createdBy: principal?.id ?? res.locals.user ?? "unknown",
      group,
      roleIds,
      expiresAt,
    });
    res.status(201).json({ key: created.plaintext, apiKey: created.doc });
  } catch (err) {
    next(err);
  }
});

// GET /api-keys → { apiKeys: [...] } (redacted — no hash, no plaintext).
// Hard isolation: a key is visible to members of its bound group + its creator
// (admins see all).
apiKeysRouter.get("/api-keys", authorize("keys:read"), async (_req, res, next) => {
  try {
    const principal = res.locals.principal;
    const all = await apiKeyStore.list();
    const visible = all.filter((k) => canRead(principal, { ownerGroup: k.group ?? null, ownerUser: k.createdBy }));
    res.json({ apiKeys: visible });
  } catch (err) {
    next(err);
  }
});

// DELETE /api-keys/:id → revoke (idempotent; 404 if unknown/already revoked)
apiKeysRouter.delete("/api-keys/:id", authorize("keys:manage"), async (req, res, next) => {
  try {
    const ok = await apiKeyStore.revoke(req.params["id"]!);
    if (!ok) return res.status(404).json({ error: { code: "NOT_FOUND_OR_ALREADY_REVOKED" } });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
