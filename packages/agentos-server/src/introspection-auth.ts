// Service-to-service guard for the API-key introspection endpoint.
//
// The introspection route (POST /agentos/api/keys/introspect) is a key-validity
// oracle: it tells the caller whether a presented key is active. Left open it
// would let anyone test leaked/suspected keys and would be a DoS amplifier
// (every call is a Mongo lookup). So it is gated by a service secret shared with
// the one trusted caller (the ComputerAgent server), NOT the dashboard's
// cookie/Basic auth (the harness is a service, not a browser).
//
// Unlike requireIngestAuth (which fails OPEN when its token is unset), this
// fails CLOSED: an unconfigured secret returns 503 so the oracle is never open.

import type { RequestHandler } from "express";
import { timingSafeEqual } from "node:crypto";

export const requireIntrospectionAuth: RequestHandler = (req, res, next) => {
  const expected = process.env["AGENTOS_INTROSPECTION_SECRET"];
  if (!expected) {
    return res.status(503).json({ error: { code: "INTROSPECTION_DISABLED" } });
  }
  const header = req.header("authorization") ?? "";
  const prefix = "Bearer ";
  if (header.startsWith(prefix)) {
    const got = Buffer.from(header.slice(prefix.length), "utf8");
    const want = Buffer.from(expected, "utf8");
    if (got.length === want.length && timingSafeEqual(got, want)) return next();
  }
  res.status(401).json({ error: { code: "UNAUTHENTICATED" } });
};
