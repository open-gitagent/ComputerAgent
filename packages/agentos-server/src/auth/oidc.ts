// OIDC integration with Keycloak (the broker; Okta federates behind it).
// AgentOS is the `agentos-bff` confidential client: it runs the Authorization
// Code + PKCE flow server-side and verifies tokens against Keycloak's JWKS.
//
// Config is all env (see §Env in the plan). `createRemoteJWKSet` caches signing
// keys in-process and refetches on an unknown `kid`, so it is created once.

import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { createHash, randomBytes } from "node:crypto";
import type { Principal } from "./principal.js";

const env = (name: string): string | undefined => process.env[name];
const issuer = (): string => (env("KEYCLOAK_ISSUER_URL") ?? "").replace(/\/+$/, "");
const clientId = (): string => env("OIDC_CLIENT_ID") ?? "";
const clientSecret = (): string => env("OIDC_CLIENT_SECRET") ?? "";
// Audience is OPTIONAL: enforced only when OIDC_AUDIENCE is set. Keycloak's
// default access token does not carry the client as `aud` (needs an audience
// mapper), so requiring it would reject every token out of the box.
const audience = (): string | undefined => env("OIDC_AUDIENCE") || undefined;
const redirectUri = (): string => env("OIDC_REDIRECT_URI") ?? "";
const postLogoutUri = (): string => env("OIDC_POST_LOGOUT_URI") ?? "/";
const rolesClaim = (): string => env("OIDC_ROLES_CLAIM") || "realm_access.roles";
const groupsClaim = (): string => env("OIDC_GROUPS_CLAIM") || "groups";
const clockSkewSec = (): number => parseInt(env("OIDC_CLOCK_SKEW_SEC") ?? "60", 10);

const jwksUrl = (): string => env("KEYCLOAK_JWKS_URL") || `${issuer()}/protocol/openid-connect/certs`;
const authorizeEndpoint = (): string => `${issuer()}/protocol/openid-connect/auth`;
const tokenEndpoint = (): string => `${issuer()}/protocol/openid-connect/token`;
const logoutEndpoint = (): string => `${issuer()}/protocol/openid-connect/logout`;

/** OIDC is usable once we know where Keycloak is and who we are to it. */
export function oidcConfigured(): boolean {
  return Boolean(issuer() && clientId());
}

// Lazily-created, process-wide JWKS (its own cache + rotation handling).
let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
function getJwks(): ReturnType<typeof createRemoteJWKSet> {
  if (!jwks) jwks = createRemoteJWKSet(new URL(jwksUrl()));
  return jwks;
}

/** Verify a Keycloak access token (signature + iss + aud + exp/nbf with skew). */
export async function verifyAccessToken(token: string): Promise<JWTPayload> {
  const aud = audience();
  const { payload } = await jwtVerify(token, getJwks(), {
    issuer: issuer(),
    ...(aud ? { audience: aud } : {}),
    clockTolerance: clockSkewSec(),
  });
  return payload;
}

function dig(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>(
    (acc, k) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[k] : undefined),
    obj,
  );
}
function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** Map verified claims to a user Principal. `permissions` is filled later by
 *  resolvePermissions (from the DB role map); the token only carries names. */
export function claimsToPrincipal(payload: JWTPayload): Principal {
  const roles = asStringArray(dig(payload, rolesClaim()));
  // Group claims may be full-path ("/agentos-editors") or plain; normalize to
  // the leaf-ish name by stripping a single leading slash.
  const groups = asStringArray(dig(payload, groupsClaim())).map((g) => g.replace(/^\//, ""));
  const email = typeof payload["email"] === "string" ? (payload["email"] as string) : undefined;
  const name =
    typeof payload["name"] === "string"
      ? (payload["name"] as string)
      : typeof payload["preferred_username"] === "string"
        ? (payload["preferred_username"] as string)
        : undefined;
  return {
    id: String(payload.sub ?? ""),
    kind: "user",
    email,
    displayName: name,
    roles,
    groups,
    permissions: [],
    source: "oidc",
  };
}

// ── BFF helpers (Authorization Code + PKCE) ──────────────────────────────────

export interface PkcePair {
  verifier: string;
  challenge: string;
}

export function makePkce(): PkcePair {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function makeState(): string {
  return randomBytes(16).toString("base64url");
}

export function buildAuthorizeUrl(state: string, codeChallenge: string): string {
  const u = new URL(authorizeEndpoint());
  u.searchParams.set("client_id", clientId());
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", "openid profile email");
  u.searchParams.set("redirect_uri", redirectUri());
  u.searchParams.set("state", state);
  u.searchParams.set("code_challenge", codeChallenge);
  u.searchParams.set("code_challenge_method", "S256");
  return u.toString();
}

export interface TokenResponse {
  access_token: string;
  id_token?: string;
  refresh_token?: string;
  expires_in?: number;
  /** Lifetime of the returned refresh token (seconds). Keycloak online tokens
   *  track the SSO-session-idle window; we use it to size the refresh cookie. */
  refresh_expires_in?: number;
}

export async function exchangeCode(code: string, codeVerifier: string): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri(),
    client_id: clientId(),
    code_verifier: codeVerifier,
  });
  if (clientSecret()) body.set("client_secret", clientSecret());
  const r = await fetch(tokenEndpoint(), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => "");
    throw new Error(`OIDC token exchange failed: ${r.status} ${detail.slice(0, 300)}`);
  }
  return (await r.json()) as TokenResponse;
}

/** Exchange a (rotating, online) refresh token for a fresh token set. Throws on
 *  any non-2xx — caller treats that as "session is gone, re-authenticate". */
export async function refreshTokens(refreshToken: string): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId(),
  });
  if (clientSecret()) body.set("client_secret", clientSecret());
  const r = await fetch(tokenEndpoint(), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => "");
    throw new Error(`OIDC token refresh failed: ${r.status} ${detail.slice(0, 300)}`);
  }
  return (await r.json()) as TokenResponse;
}

export function buildLogoutUrl(idToken?: string): string {
  const u = new URL(logoutEndpoint());
  u.searchParams.set("post_logout_redirect_uri", postLogoutUri());
  if (idToken) u.searchParams.set("id_token_hint", idToken);
  return u.toString();
}
