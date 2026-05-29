// PUBLIC auth routes — mounted before the requireAuth middleware.
//   POST /agentos/api/login   — credentials → cookie
//   POST /agentos/api/logout  — clear cookie
//   GET  /agentos/api/me      — current user (cookie OR Basic)

import { Router, type Router as IRouter } from "express";
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE_SEC,
  checkBasic,
  signSession,
  verifySession,
} from "../auth.js";

export const authRouter: IRouter = Router();

const cookieSecure = (): boolean => {
  if (process.env["COOKIE_SECURE"] === "true") return true;
  if (process.env["COOKIE_SECURE"] === "false") return false;
  return process.env["NODE_ENV"] === "production";
};

authRouter.post("/login", async (req, res) => {
  const body = (req.body ?? {}) as { user?: string; pass?: string };
  const expectedUser = process.env["API_AUTH_USER"];
  const expectedPass = process.env["API_AUTH_PASS"];
  if (!expectedUser || !expectedPass) {
    return res.status(503).json({ error: { code: "AUTH_NOT_CONFIGURED" } });
  }
  if (body.user !== expectedUser || body.pass !== expectedPass) {
    return res.status(401).json({ error: { code: "INVALID_CREDENTIALS" } });
  }
  const expMs = Date.now() + SESSION_MAX_AGE_SEC * 1000;
  const token = signSession(body.user, expMs);
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: cookieSecure(),
    sameSite: "strict",
    maxAge: SESSION_MAX_AGE_SEC * 1000,
    path: "/",
  });
  res.json({ ok: true, user: body.user });
});

authRouter.post("/logout", (_req, res) => {
  res.clearCookie(SESSION_COOKIE, { path: "/" });
  res.json({ ok: true });
});

authRouter.get("/me", (req, res) => {
  const cookie = req.cookies?.[SESSION_COOKIE];
  if (typeof cookie === "string" && cookie.length > 0) {
    const session = verifySession(cookie);
    if (session) return res.json({ user: session.user, source: "cookie" });
  }
  const basicUser = checkBasic(req.header("authorization") ?? undefined);
  if (basicUser) return res.json({ user: basicUser, source: "basic" });
  res.status(401).json({ user: null });
});
