// Unit tests for the authenticate gate. api-key-store + oidc are mocked; the
// real signed-cookie helpers from ../auth.js are used for the BFF-cookie path.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  verify: vi.fn(),
  oidcConfigured: vi.fn(() => true),
  verifyAccessToken: vi.fn(),
  claimsToPrincipal: vi.fn(),
}));
vi.mock("../stores/api-key-store.js", () => ({
  apiKeyStore: { verify: h.verify },
  KEY_PREFIX: "cak_",
}));
vi.mock("./oidc.js", () => ({
  oidcConfigured: h.oidcConfigured,
  verifyAccessToken: h.verifyAccessToken,
  claimsToPrincipal: h.claimsToPrincipal,
}));

import { authenticate } from "./authenticate.js";
import { SESSION_COOKIE, signSessionSnapshot } from "../auth.js";
import type { Principal } from "./principal.js";

interface Ctx {
  req: import("express").Request;
  res: { locals: { principal?: Principal; user?: string }; statusCode: number; body: unknown };
  nexted: () => boolean;
}

function makeCtx(opts: { header?: string; cookies?: Record<string, string> } = {}): Ctx {
  const req = {
    header: (n: string) => (n.toLowerCase() === "authorization" ? opts.header : undefined),
    cookies: opts.cookies ?? {},
  } as unknown as import("express").Request;
  let nexted = false;
  const res: any = { locals: {}, statusCode: 0, body: undefined };
  res.status = (c: number) => ((res.statusCode = c), res);
  res.json = (b: unknown) => ((res.body = b), res);
  const next = () => {
    nexted = true;
  };
  authenticate(req, res as never, next as never);
  return { req, res, nexted: () => nexted };
}

async function settle(c: Ctx) {
  await vi.waitFor(() => {
    if (!c.nexted() && c.res.statusCode === 0) throw new Error("pending");
  });
}

beforeEach(() => {
  h.verify.mockReset();
  h.oidcConfigured.mockReturnValue(true);
  h.verifyAccessToken.mockReset();
  h.claimsToPrincipal.mockReset();
  delete process.env["AGENTOS_DEV_AUTH"];
});
afterEach(() => delete process.env["AGENTOS_DEV_AUTH"]);

describe("authenticate", () => {
  it("dev bypass injects an admin principal when AGENTOS_DEV_AUTH=1", async () => {
    process.env["AGENTOS_DEV_AUTH"] = "1";
    const c = makeCtx();
    await settle(c);
    expect(c.nexted()).toBe(true);
    expect(c.res.locals.principal?.source).toBe("dev");
    expect(c.res.locals.principal?.roles).toContain("agentos-admin");
  });

  it("resolves a service principal from a valid API key", async () => {
    h.verify.mockResolvedValue({ active: true, principal: "key_1", roleIds: ["agentos-editor"], group: "editors", scopes: ["*"] });
    const c = makeCtx({ header: "Bearer cak_abc" });
    await settle(c);
    expect(c.nexted()).toBe(true);
    expect(c.res.locals.principal).toMatchObject({ kind: "service", id: "key_1", roles: ["agentos-editor"], groups: ["editors"], source: "api-key" });
  });

  it("401s on an invalid API key", async () => {
    h.verify.mockResolvedValue(null);
    const c = makeCtx({ header: "Bearer cak_bad" });
    await settle(c);
    expect(c.nexted()).toBe(false);
    expect(c.res.statusCode).toBe(401);
  });

  it("resolves a user principal from a verified OIDC token", async () => {
    h.verifyAccessToken.mockResolvedValue({ sub: "okta|1" });
    h.claimsToPrincipal.mockReturnValue({ id: "okta|1", kind: "user", roles: ["agentos-viewer"], groups: ["viewers"], permissions: [], source: "oidc", email: "a@x.io" });
    const c = makeCtx({ header: "Bearer header.jwt.sig" });
    await settle(c);
    expect(c.nexted()).toBe(true);
    expect(c.res.locals.principal).toMatchObject({ kind: "user", id: "okta|1", source: "oidc" });
    expect(c.res.locals.user).toBe("a@x.io");
  });

  it("resolves a user principal from the BFF session cookie", async () => {
    const cookie = signSessionSnapshot({ sub: "okta|2", email: "b@x.io", roles: ["agentos-editor"], groups: ["editors"] }, Date.now() + 60_000);
    const c = makeCtx({ cookies: { [SESSION_COOKIE]: cookie } });
    await settle(c);
    expect(c.nexted()).toBe(true);
    expect(c.res.locals.principal).toMatchObject({ kind: "user", id: "okta|2", source: "cookie", roles: ["agentos-editor"] });
  });

  it("401s when nothing authenticates and dev bypass is off", async () => {
    const c = makeCtx();
    await settle(c);
    expect(c.nexted()).toBe(false);
    expect(c.res.statusCode).toBe(401);
  });
});
