// Stateless auth: HMAC-signed cookie OR Basic Auth header.
//   - Cookie name:  agentos_session
//   - Cookie value: <user>.<exp_ms>.<base64url(hmac_sha256(secret, user.exp))>
//   - Secret:       AGENTOS_SESSION_SECRET env (random per-process fallback)
//
// Basic Auth is the curl/scheduler escape hatch — it's matched against the
// same API_AUTH_USER/PASS the harness server uses, so scripts and ops tools
// authenticate the same way everywhere.

import type { RequestHandler } from "express";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "agentos_session";
export const SESSION_MAX_AGE_SEC = 7 * 24 * 60 * 60; // 7 days

const SESSION_SECRET =
  process.env["AGENTOS_SESSION_SECRET"] || randomBytes(32).toString("hex");

export function signSession(user: string, expMs: number): string {
  const data = `${user}.${expMs}`;
  const sig = createHmac("sha256", SESSION_SECRET).update(data).digest("base64url");
  return `${data}.${sig}`;
}

export function verifySession(cookie: string): { user: string; exp: number } | null {
  const parts = cookie.split(".");
  if (parts.length !== 3) return null;
  const [user, expStr, sig] = parts as [string, string, string];
  const expected = createHmac("sha256", SESSION_SECRET).update(`${user}.${expStr}`).digest("base64url");
  const a = Buffer.from(sig, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const exp = Number.parseInt(expStr, 10);
  if (!Number.isFinite(exp) || Date.now() > exp) return null;
  return { user, exp };
}

export function checkBasic(header: string | undefined): string | null {
  if (!header || !header.startsWith("Basic ")) return null;
  const expectedUser = process.env["API_AUTH_USER"];
  const expectedPass = process.env["API_AUTH_PASS"];
  if (!expectedUser || !expectedPass) return null;
  try {
    const decoded = Buffer.from(header.slice(6), "base64").toString();
    const idx = decoded.indexOf(":");
    if (idx < 0) return null;
    const user = decoded.slice(0, idx);
    const pass = decoded.slice(idx + 1);
    if (user === expectedUser && pass === expectedPass) return user;
  } catch { /* malformed */ }
  return null;
}

declare global {
  namespace Express {
    interface Locals {
      user?: string;
    }
  }
}

/** Cookie session OR genuine Basic header. Sets res.locals.user on success. */
export const requireAuth: RequestHandler = (req, res, next) => {
  const cookie = req.cookies?.[SESSION_COOKIE];
  if (typeof cookie === "string" && cookie.length > 0) {
    const session = verifySession(cookie);
    if (session) {
      res.locals.user = session.user;
      return next();
    }
  }
  const basicUser = checkBasic(req.header("authorization") ?? undefined);
  if (basicUser) {
    res.locals.user = basicUser;
    return next();
  }
  res.status(401).json({ error: { code: "UNAUTHENTICATED" } });
};

/** Basic header to forward to the harness server on outbound loopback calls. */
export function caAuthHeader(): Record<string, string> {
  const u = process.env["API_AUTH_USER"];
  const p = process.env["API_AUTH_PASS"];
  if (!u || !p) return {};
  return { authorization: "Basic " + Buffer.from(`${u}:${p}`).toString("base64") };
}
