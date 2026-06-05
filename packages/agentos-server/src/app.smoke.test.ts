// End-to-end smoke: build the real app, listen on an ephemeral port, and assert
// the route tree + auth gate. AGENTOS_DEV_AUTH is toggled per-request (the gate
// reads it live) to exercise both the authenticated and 401 paths without a
// real Keycloak or Mongo (the dev principal's "*" short-circuits the role-map
// lookup, and the 401 path rejects before any handler touches Mongo).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import { buildApp } from "./app.js";

let server: Server;
let base = "";

beforeAll(async () => {
  const app = buildApp();
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  base = `http://127.0.0.1:${port}`;
});

afterAll(() => {
  server?.close();
  delete process.env["AGENTOS_DEV_AUTH"];
});

describe("app routing + auth gate", () => {
  it("GET /agentos/api/v1/me returns the dev principal when AGENTOS_DEV_AUTH=1", async () => {
    process.env["AGENTOS_DEV_AUTH"] = "1";
    const r = await fetch(`${base}/agentos/api/v1/me`);
    expect(r.status).toBe(200);
    const j = (await r.json()) as { kind: string; permissions: string[]; source: string };
    expect(j.kind).toBe("user");
    expect(j.source).toBe("dev");
    expect(j.permissions).toContain("*");
  });

  it("the legacy un-versioned dashboard base is gone (only /agentos/api/v1 serves it)", async () => {
    process.env["AGENTOS_DEV_AUTH"] = "1";
    const r = await fetch(`${base}/agentos/api/me`);
    expect(r.status).toBe(404);
  });

  it("401s on a gated dashboard route when unauthenticated (dev bypass off)", async () => {
    delete process.env["AGENTOS_DEV_AUTH"];
    const r = await fetch(`${base}/agentos/api/v1/agents`);
    expect(r.status).toBe(401);
    const j = (await r.json()) as { error: { code: string } };
    expect(j.error.code).toBe("UNAUTHENTICATED");
  });

  it("401s on /me when unauthenticated (the SPA's signal to show SSO sign-in)", async () => {
    delete process.env["AGENTOS_DEV_AUTH"];
    const r = await fetch(`${base}/agentos/api/v1/me`);
    expect(r.status).toBe(401);
  });

  it("login redirects to Keycloak only when OIDC is configured (else 503)", async () => {
    delete process.env["AGENTOS_DEV_AUTH"];
    const r = await fetch(`${base}/agentos/api/v1/auth/login`, { redirect: "manual" });
    // OIDC env is unset in the test → 503 OIDC_NOT_CONFIGURED (never a redirect).
    expect(r.status).toBe(503);
  });
});
