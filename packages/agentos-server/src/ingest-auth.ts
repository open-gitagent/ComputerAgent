// Machine-to-machine auth for the telemetry ingest endpoint.
//
// The dashboard's cookie/Basic `requireAuth` is for browsers; the Python SDK
// posts events headless, so the ingest route gets its own bearer-token guard
// keyed on AGENTOS_INGEST_TOKEN. When the env is unset the route is OPEN
// (relies on network policy) — same philosophy as API_AUTH_* in auth.ts.

import type { RequestHandler } from "express";
import { timingSafeEqual } from "node:crypto";

export const requireIngestAuth: RequestHandler = (req, res, next) => {
  const expected = process.env["AGENTOS_INGEST_TOKEN"];
  if (!expected) return next(); // open — network policy only

  const header = req.header("authorization") ?? "";
  const prefix = "Bearer ";
  if (header.startsWith(prefix)) {
    const got = Buffer.from(header.slice(prefix.length), "utf8");
    const want = Buffer.from(expected, "utf8");
    if (got.length === want.length && timingSafeEqual(got, want)) return next();
  }
  res.status(401).json({ error: { code: "UNAUTHENTICATED" } });
};
