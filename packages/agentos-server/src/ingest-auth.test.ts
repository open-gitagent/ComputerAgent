// Unit tests for requireIngestAuth. api-key-store is mocked so the cak_
// validation path is exercised without Mongo.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({ verify: vi.fn() }));
vi.mock("./stores/api-key-store.js", () => ({
  apiKeyStore: { verify: h.verify },
  KEY_PREFIX: "cak_",
}));

import { requireIngestAuth } from "./ingest-auth.js";

function ctx(authHeader?: string) {
  const req = {
    header: (n: string) => (n.toLowerCase() === "authorization" ? authHeader : undefined),
  } as unknown as import("express").Request;
  let statusCode = 0;
  let jsonBody: unknown;
  const res = {
    status(c: number) {
      statusCode = c;
      return this;
    },
    json(b: unknown) {
      jsonBody = b;
      return this;
    },
  } as unknown as import("express").Response;
  let passed = false;
  const next = () => {
    passed = true;
  };
  return {
    req,
    res,
    next,
    passed: () => passed,
    status: () => statusCode,
    body: () => jsonBody as { error?: { code?: string } },
  };
}

const ORIGINAL = process.env["AGENTOS_INGEST_TOKEN"];

beforeEach(() => {
  h.verify.mockReset();
  delete process.env["AGENTOS_INGEST_TOKEN"];
});

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env["AGENTOS_INGEST_TOKEN"];
  else process.env["AGENTOS_INGEST_TOKEN"] = ORIGINAL;
});

describe("requireIngestAuth — cak_ API key", () => {
  it("accepts a valid cak_ key (verified via apiKeyStore)", async () => {
    h.verify.mockResolvedValue({ active: true, principal: "key_abc", roleIds: [], scopes: ["*"] });
    const c = ctx("Bearer cak_validkey");
    await requireIngestAuth(c.req, c.res, c.next);
    expect(c.passed()).toBe(true);
    expect(h.verify).toHaveBeenCalledWith("cak_validkey");
  });

  it("rejects an inactive/unknown cak_ key with 401", async () => {
    h.verify.mockResolvedValue(null);
    const c = ctx("Bearer cak_revoked");
    await requireIngestAuth(c.req, c.res, c.next);
    expect(c.passed()).toBe(false);
    expect(c.status()).toBe(401);
    expect(c.body().error?.code).toBe("UNAUTHENTICATED");
  });

  it("fails closed with 503 when key verification throws (Mongo down)", async () => {
    h.verify.mockRejectedValue(new Error("connection refused"));
    const c = ctx("Bearer cak_whatever");
    await requireIngestAuth(c.req, c.res, c.next);
    expect(c.passed()).toBe(false);
    expect(c.status()).toBe(503);
    expect(c.body().error?.code).toBe("KEY_VERIFICATION_UNAVAILABLE");
  });

  it("never consults the legacy token for a cak_ key", async () => {
    process.env["AGENTOS_INGEST_TOKEN"] = "cak_validkey"; // even if it matches verbatim
    h.verify.mockResolvedValue(null);
    const c = ctx("Bearer cak_validkey");
    await requireIngestAuth(c.req, c.res, c.next);
    expect(c.status()).toBe(401); // a cak_ must be a real key, not string-equal to the legacy token
  });
});

describe("requireIngestAuth — legacy static token (back-compat)", () => {
  it("accepts a matching AGENTOS_INGEST_TOKEN", async () => {
    process.env["AGENTOS_INGEST_TOKEN"] = "s3cr3t";
    const c = ctx("Bearer s3cr3t");
    await requireIngestAuth(c.req, c.res, c.next);
    expect(c.passed()).toBe(true);
    expect(h.verify).not.toHaveBeenCalled();
  });

  it("rejects a wrong token with 401", async () => {
    process.env["AGENTOS_INGEST_TOKEN"] = "s3cr3t";
    const c = ctx("Bearer nope");
    await requireIngestAuth(c.req, c.res, c.next);
    expect(c.status()).toBe(401);
  });

  it("rejects when token is configured but none is presented", async () => {
    process.env["AGENTOS_INGEST_TOKEN"] = "s3cr3t";
    const c = ctx(undefined);
    await requireIngestAuth(c.req, c.res, c.next);
    expect(c.status()).toBe(401);
  });
});

describe("requireIngestAuth — open mode", () => {
  it("passes when no token is configured and none is presented (network policy)", async () => {
    const c = ctx(undefined);
    await requireIngestAuth(c.req, c.res, c.next);
    expect(c.passed()).toBe(true);
  });

  it("passes a non-cak bearer when no token is configured", async () => {
    const c = ctx("Bearer some-random-thing");
    await requireIngestAuth(c.req, c.res, c.next);
    expect(c.passed()).toBe(true);
  });
});
