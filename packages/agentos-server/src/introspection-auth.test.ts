// Unit test for requireIntrospectionAuth — the service-secret guard on the
// key-introspection endpoint. Security-critical: it must FAIL CLOSED (503) when
// the secret is unset, and only pass on an exact Bearer match.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requireIntrospectionAuth } from "./introspection-auth.js";

function fakeCtx(authHeader?: string) {
  const res: any = {
    statusCode: 0,
    body: null,
    status(c: number) { this.statusCode = c; return this; },
    json(o: unknown) { this.body = o; return this; },
  };
  const req: any = { header: (n: string) => (n.toLowerCase() === "authorization" ? authHeader : undefined) };
  const next = vi.fn();
  return { req, res, next };
}

beforeEach(() => { delete process.env["AGENTOS_INTROSPECTION_SECRET"]; });
afterEach(() => { delete process.env["AGENTOS_INTROSPECTION_SECRET"]; });

describe("requireIntrospectionAuth", () => {
  it("fails closed with 503 when the secret is unset", () => {
    const { req, res, next } = fakeCtx("Bearer anything");
    requireIntrospectionAuth(req, res, next);
    expect(res.statusCode).toBe(503);
    expect(next).not.toHaveBeenCalled();
  });

  it("401s on a missing or wrong bearer", () => {
    process.env["AGENTOS_INTROSPECTION_SECRET"] = "svc-secret";
    for (const hdr of [undefined, "", "Bearer wrong", "Basic svc-secret"]) {
      const { req, res, next } = fakeCtx(hdr);
      requireIntrospectionAuth(req, res, next);
      expect(res.statusCode).toBe(401);
      expect(next).not.toHaveBeenCalled();
    }
  });

  it("passes on the exact bearer secret", () => {
    process.env["AGENTOS_INTROSPECTION_SECRET"] = "svc-secret";
    const { req, res, next } = fakeCtx("Bearer svc-secret");
    requireIntrospectionAuth(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.statusCode).toBe(0);
  });
});
