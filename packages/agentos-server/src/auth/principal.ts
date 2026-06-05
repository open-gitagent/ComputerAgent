// The unified Principal — what every authenticated caller resolves to,
// regardless of how they authenticated. Set on `res.locals.principal` by
// `authenticate` (Stage 3) or synthesized from the legacy session by
// `resolvePermissions` (Stage 2 bridge). `res.locals.user` is kept as a plain
// string for back-compat (its only reader is api-keys.ts `createdBy`).

export type PrincipalKind = "user" | "service";
export type PrincipalSource = "oidc" | "api-key" | "cookie" | "dev";

export interface Principal {
  /** user → Keycloak `sub`; service → api-key doc `_id` ("key_..."). */
  id: string;
  kind: PrincipalKind;
  email?: string;
  displayName?: string;
  /** Role NAMES — from the token (users) or stamped on the key (service). */
  roles: string[];
  /** Raw Okta/Keycloak group names — display + the key-mint grantable set. */
  groups: string[];
  /** RESOLVED permission keys (union over `roles` via the DB role map). "*" = all. */
  permissions: string[];
  source: PrincipalSource;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Locals {
      principal?: Principal;
    }
  }
}
