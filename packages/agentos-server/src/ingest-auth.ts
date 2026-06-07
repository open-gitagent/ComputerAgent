// Machine-to-machine auth for the telemetry ingest endpoint.
//
// The dashboard's cookie/Basic `requireAuth` is for browsers; the Python SDK
// posts events headless. The SDK uses ONE credential everywhere — the `cak_`
// API key it already presents to the ComputerAgent server — so ingest verifies
// that same key (via `apiKeyStore`, the same path the CAS introspection uses)
// rather than a separate shared secret.
//
// Auth resolution order:
//   1. Bearer `cak_…`            → validate against `api_keys` (active/not
//                                   revoked/not expired). Invalid → 401.
//   2. Bearer <AGENTOS_INGEST_TOKEN>  → legacy shared-secret, kept for
//                                   back-compat with older deployments.
//   3. Neither presented AND no AGENTOS_INGEST_TOKEN configured → OPEN
//                                   (relies on network policy — same philosophy
//                                   as API_AUTH_* in auth.ts). Once a `cak_` is
//                                   presented it is always validated, never
//                                   waved through.

import type { RequestHandler } from "express";
import { timingSafeEqual } from "node:crypto";
import { apiKeyStore, KEY_PREFIX } from "./stores/api-key-store.js";

function unauthenticated(res: Parameters<RequestHandler>[1]): void {
  res.status(401).json({ error: { code: "UNAUTHENTICATED" } });
}

export const requireIngestAuth: RequestHandler = async (req, res, next) => {
  const header = req.header("authorization") ?? "";
  const prefix = "Bearer ";
  const presented = header.startsWith(prefix) ? header.slice(prefix.length) : "";

  // (1) API key — the same `cak_` key the SDK uses everywhere.
  if (presented.startsWith(KEY_PREFIX)) {
    try {
      const result = await apiKeyStore.verify(presented);
      if (result) return next();
      return unauthenticated(res); // recognized shape, but inactive/revoked/unknown
    } catch (err) {
      // Validation infra (Mongo) is down — fail closed, but distinguish from a
      // bad key so the caller can retry rather than treating it as a 401.
      console.warn("[agentos-server] ingest key verification failed:", (err as Error).message);
      return res.status(503).json({ error: { code: "KEY_VERIFICATION_UNAVAILABLE" } });
    }
  }

  // (2) Back-compat: legacy static shared ingest token.
  const expected = process.env["AGENTOS_INGEST_TOKEN"];
  if (expected) {
    if (presented) {
      const got = Buffer.from(presented, "utf8");
      const want = Buffer.from(expected, "utf8");
      if (got.length === want.length && timingSafeEqual(got, want)) return next();
    }
    return unauthenticated(res);
  }

  // (3) Nothing presented and nothing configured → open (network policy only).
  return next();
};
