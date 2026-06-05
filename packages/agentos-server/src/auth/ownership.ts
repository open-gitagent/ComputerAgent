// Resource-level authorization (multi-tenancy). RBAC answers "may this principal
// perform this ACTION?"; ownership answers "on THIS resource?".
//
// Model (decided with the user): each owned resource carries `ownerGroup` (an
// Okta/Keycloak group) and `ownerUser` (the creator's principal id).
//   - READ / visibility (hard isolation): admins → all; otherwise visible only
//     to the creator (ownerUser) or members of the owner group. A resource with
//     no owner group is visible only to its creator + admins (never world-read).
//   - WRITE / mutate / delete: admins → all; otherwise only the owner user.
//     Group members get read; the creator (or an admin) writes.
//
// "admin" = a principal holding the "*" wildcard permission (the agentos-admin
// role). Such principals bypass ownership entirely.

import type { Principal } from "./principal.js";
import { WILDCARD } from "./permissions.js";

export interface Owned {
  ownerGroup?: string | null;
  ownerUser?: string | null;
}

export function isSuperuser(p?: Principal): boolean {
  return !!p && p.permissions.includes(WILDCARD);
}

/** Visibility (hard isolation) — admins see all; otherwise you must be the
 *  creator (ownerUser) or a member of the owner group. Resources with no owner
 *  group are visible only to their creator + admins (never world-readable). */
export function canRead(p: Principal | undefined, r: Owned): boolean {
  if (isSuperuser(p)) return true;
  if (!p) return false;
  if (r.ownerUser && r.ownerUser === p.id) return true; // your own resource
  if (r.ownerGroup && p.groups.includes(r.ownerGroup)) return true; // your group's
  return false;
}

/** Mutate/delete — admins all; else only the owner user. Unowned → admin only. */
export function canWrite(p: Principal | undefined, r: Owned): boolean {
  if (isSuperuser(p)) return true;
  return !!p && !!r.ownerUser && r.ownerUser === p.id;
}

/**
 * Resolve the owner group to stamp at create time from a requested value.
 *  - admins may stamp any group (or none);
 *  - everyone else may only stamp a group they belong to;
 *  - when none is requested, defaults to the principal's first group.
 * Returns { ok:false } when the requested group isn't allowed (caller 403s).
 */
export function pickOwnerGroup(
  p: Principal,
  requested: unknown,
): { ok: true; group: string | null } | { ok: false } {
  const g = typeof requested === "string" && requested.trim() ? requested.trim() : null;
  if (!g) return { ok: true, group: p.groups[0] ?? null };
  if (isSuperuser(p) || p.groups.includes(g)) return { ok: true, group: g };
  return { ok: false };
}
