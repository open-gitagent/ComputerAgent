// PUBLIC auth routes — mounted before the gate (these must be reachable
// unauthenticated). BFF (backend-for-frontend) OIDC flow:
//
//   GET  /agentos/api/v1/auth/login     — start: state+PKCE → 302 to Keycloak
//   GET  /agentos/api/v1/auth/callback  — finish: code → tokens → session cookie
//   POST /agentos/api/v1/logout         — clear session (+ Keycloak end-session)
//   GET  /agentos/api/v1/me             — current principal (roles/groups/permissions)
//
// The browser never sees a token — the server holds them and sets an httpOnly
// `agentos_session` cookie carrying a signed principal snapshot.

import { Router, type Router as IRouter, type Response } from "express";
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE_SEC,
  REFRESH_COOKIE,
  signSessionSnapshot,
  signRefresh,
  verifyRefresh,
  signJson,
  verifyJson,
} from "../auth.js";
import { authenticate } from "../auth/authenticate.js";
import { resolvePermissions } from "../auth/authorize.js";
import type { Principal } from "../auth/principal.js";
import { keycloakAdminConfigured, listUserGroups } from "../auth/keycloak-admin.js";
import {
  oidcConfigured,
  makeState,
  makePkce,
  buildAuthorizeUrl,
  buildLogoutUrl,
  exchangeCode,
  refreshTokens,
  verifyAccessToken,
  claimsToPrincipal,
  type TokenResponse,
} from "../auth/oidc.js";

export const authRouter: IRouter = Router();

const TX_COOKIE = "agentos_oidc_tx";
const ID_TOKEN_COOKIE = "agentos_id_token";
const TX_TTL_MS = 5 * 60 * 1000;

const cookieSecure = (): boolean => {
  if (process.env["COOKIE_SECURE"] === "true") return true;
  if (process.env["COOKIE_SECURE"] === "false") return false;
  return process.env["NODE_ENV"] === "production";
};

interface OidcTx {
  state: string;
  verifier: string;
  exp: number;
}

// Refresh-cookie default lifetime when Keycloak omits `refresh_expires_in`
// (seconds). Caps how long an idle tab can silently refresh before re-login.
const REFRESH_FALLBACK_SEC = parseInt(process.env["AGENTOS_REFRESH_MAX_AGE_SEC"] ?? "1800", 10);

// Tenancy depends on the principal's groups, which come from the token's
// `groups` claim. If that claim is absent (no Group Membership mapper on the
// client), fall back to the Keycloak Admin API so group-scoped visibility still
// works. Best-effort: any failure leaves groups as-is.
async function withGroups(principal: Principal): Promise<Principal> {
  if (principal.groups.length > 0 || !principal.id || !keycloakAdminConfigured()) return principal;
  try {
    const groups = await listUserGroups(principal.id);
    if (groups.length) return { ...principal, groups };
  } catch {
    /* admin API unavailable / insufficient role — leave groups empty */
  }
  return principal;
}

function accessTokenExpMs(accessToken: string): number {
  try {
    const [, body] = accessToken.split(".");
    const decoded = JSON.parse(Buffer.from(body ?? "", "base64url").toString("utf8")) as { exp?: number };
    return typeof decoded.exp === "number" ? decoded.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

// Persist a fresh token set as cookies: the short-lived signed principal
// snapshot (`agentos_session`, expiry tracks the access token), the server-only
// refresh token (`agentos_refresh`, sized to refresh_expires_in), and the id
// token (for Keycloak end-session at logout). Shared by callback + refresh so
// rotation stays in one place.
function setSessionCookies(res: Response, tokens: TokenResponse, principal: Principal): void {
  const now = Date.now();

  // Session snapshot: min(access-token exp, configured max age).
  const payloadExpMs = accessTokenExpMs(tokens.access_token);
  const sessionMaxMs = now + SESSION_MAX_AGE_SEC * 1000;
  const sessionExpMs = payloadExpMs > now ? Math.min(payloadExpMs, sessionMaxMs) : sessionMaxMs;
  res.cookie(
    SESSION_COOKIE,
    signSessionSnapshot(
      { sub: principal.id, email: principal.email, name: principal.displayName, roles: principal.roles, groups: principal.groups },
      sessionExpMs,
    ),
    { httpOnly: true, secure: cookieSecure(), sameSite: "lax", maxAge: sessionExpMs - now, path: "/" },
  );

  // Refresh token (rotated on every use) — server-side only.
  if (tokens.refresh_token) {
    const refreshTtlSec = tokens.refresh_expires_in && tokens.refresh_expires_in > 0
      ? tokens.refresh_expires_in
      : REFRESH_FALLBACK_SEC;
    const refreshExpMs = now + refreshTtlSec * 1000;
    res.cookie(REFRESH_COOKIE, signRefresh(tokens.refresh_token, refreshExpMs), {
      httpOnly: true,
      secure: cookieSecure(),
      sameSite: "lax",
      maxAge: refreshExpMs - now,
      path: "/",
    });
  }

  // Id token — used as `id_token_hint` for Keycloak end-session.
  if (tokens.id_token) {
    res.cookie(ID_TOKEN_COOKIE, tokens.id_token, {
      httpOnly: true,
      secure: cookieSecure(),
      sameSite: "lax",
      maxAge: SESSION_MAX_AGE_SEC * 1000,
      path: "/",
    });
  }
}

// Start the login flow — stash state + PKCE verifier in a short-lived signed
// cookie (sameSite=lax so it survives the top-level redirect back), then bounce
// to Keycloak's authorize endpoint.
authRouter.get("/auth/login", (_req, res) => {
  if (!oidcConfigured()) {
    return res.status(503).json({ error: { code: "OIDC_NOT_CONFIGURED", message: "Keycloak/OIDC env is not set" } });
  }
  const state = makeState();
  const { verifier, challenge } = makePkce();
  const tx: OidcTx = { state, verifier, exp: Date.now() + TX_TTL_MS };
  res.cookie(TX_COOKIE, signJson(tx), {
    httpOnly: true,
    secure: cookieSecure(),
    sameSite: "lax",
    maxAge: TX_TTL_MS,
    path: "/",
  });
  res.redirect(buildAuthorizeUrl(state, challenge));
});

// Finish the login flow — validate state, exchange the code, verify the token,
// set the httpOnly session cookie, then land back on the SPA.
authRouter.get("/auth/callback", async (req, res, next) => {
  try {
    if (!oidcConfigured()) {
      return res.status(503).json({ error: { code: "OIDC_NOT_CONFIGURED" } });
    }
    const code = typeof req.query["code"] === "string" ? req.query["code"] : "";
    const state = typeof req.query["state"] === "string" ? req.query["state"] : "";
    const txRaw = req.cookies?.[TX_COOKIE];
    const tx = typeof txRaw === "string" ? verifyJson<OidcTx>(txRaw) : null;
    res.clearCookie(TX_COOKIE, { path: "/" });

    if (!code || !state || !tx || tx.state !== state || Date.now() > tx.exp) {
      return res.status(400).json({ error: { code: "BAD_OIDC_CALLBACK" } });
    }

    const tokens = await exchangeCode(code, tx.verifier);
    const principal = await withGroups(claimsToPrincipal(await verifyAccessToken(tokens.access_token)));
    setSessionCookies(res, tokens, principal);
    res.redirect("/");
  } catch (err) {
    next(err);
  }
});

// Clear the session. Returns the Keycloak end-session URL so the SPA can also
// terminate the SSO session if it wants a full logout.
authRouter.post("/logout", (req, res) => {
  const idToken = req.cookies?.[ID_TOKEN_COOKIE];
  res.clearCookie(SESSION_COOKIE, { path: "/" });
  res.clearCookie(REFRESH_COOKIE, { path: "/" });
  res.clearCookie(ID_TOKEN_COOKIE, { path: "/" });
  if (oidcConfigured() && typeof idToken === "string") {
    return res.json({ ok: true, logoutUrl: buildLogoutUrl(idToken) });
  }
  res.json({ ok: true });
});

// Silent refresh — the SPA calls this when a dashboard request 401s. Trade the
// server-held refresh token for a fresh access token, re-sign the session
// snapshot (picking up any role/group changes), and rotate the refresh cookie.
// A dead/expired/revoked refresh token clears the cookies and 401s, which the
// SPA treats as "session ended → show SSO sign-in".
authRouter.post("/auth/refresh", async (req, res, next) => {
  try {
    const raw = req.cookies?.[REFRESH_COOKIE];
    const snap = typeof raw === "string" ? verifyRefresh(raw) : null;
    if (!snap) {
      res.clearCookie(SESSION_COOKIE, { path: "/" });
      res.clearCookie(REFRESH_COOKIE, { path: "/" });
      res.clearCookie(ID_TOKEN_COOKIE, { path: "/" });
      return res.status(401).json({ error: { code: "REFRESH_REQUIRED" } });
    }
    let tokens: TokenResponse;
    try {
      tokens = await refreshTokens(snap.rt);
    } catch {
      // invalid_grant etc. — the SSO session is gone or the token was already used.
      res.clearCookie(SESSION_COOKIE, { path: "/" });
      res.clearCookie(REFRESH_COOKIE, { path: "/" });
      res.clearCookie(ID_TOKEN_COOKIE, { path: "/" });
      return res.status(401).json({ error: { code: "REFRESH_FAILED" } });
    }
    const principal = await withGroups(claimsToPrincipal(await verifyAccessToken(tokens.access_token)));
    setSessionCookies(res, tokens, principal);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Current principal — runs the gate itself (it's a public route), so a 401 here
// is the SPA's signal to show the SSO sign-in screen.
authRouter.get("/me", authenticate, resolvePermissions, (_req, res) => {
  const p = res.locals.principal!;
  res.json({
    id: p.id,
    user: p.email ?? p.id,
    displayName: p.displayName ?? null,
    source: p.source,
    kind: p.kind,
    roles: p.roles,
    groups: p.groups,
    permissions: p.permissions,
  });
});
