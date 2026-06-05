// Unit tests for authorize(perm) + resolvePermissions. role-store is mocked so
// resolvePermissions can be exercised without Mongo.

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ permissionsFor: vi.fn() }));
vi.mock("../stores/role-store.js", () => ({ roleStore: { permissionsFor: h.permissionsFor } }));

import { authorize, resolvePermissions, principalHas } from "./authorize.js";
import { ApiError } from "../http/errors.js";
import type { Principal } from "./principal.js";

function ctx(locals: Record<string, unknown> = {}) {
  const res = { locals } as unknown as import("express").Response;
  let err: unknown;
  let passed = false;
  const next = (e?: unknown) => {
    if (e) err = e;
    else passed = true;
  };
  return { res, next, getErr: () => err, passed: () => passed };
}

const user = (permissions: string[], roles: string[] = []): Principal => ({
  id: "u1",
  kind: "user",
  roles,
  groups: [],
  permissions,
  source: "oidc",
});

describe("authorize(perm)", () => {
  it("passes when the principal holds the permission", () => {
    const c = ctx({ principal: user(["agents:read"]) });
    authorize("agents:read")({} as never, c.res, c.next);
    expect(c.passed()).toBe(true);
  });

  it("passes on the wildcard", () => {
    const c = ctx({ principal: user(["*"]) });
    authorize("agents:delete")({} as never, c.res, c.next);
    expect(c.passed()).toBe(true);
  });

  it("403 INSUFFICIENT_PERMISSION when the permission is missing", () => {
    const c = ctx({ principal: user(["agents:read"]) });
    authorize("agents:delete")({} as never, c.res, c.next);
    const e = c.getErr() as ApiError;
    expect(e).toBeInstanceOf(ApiError);
    expect(e.status).toBe(403);
    expect(e.code).toBe("INSUFFICIENT_PERMISSION");
  });

  it("401 when there is no principal", () => {
    const c = ctx({});
    authorize("agents:read")({} as never, c.res, c.next);
    expect((c.getErr() as ApiError).status).toBe(401);
  });
});

describe("principalHas", () => {
  it("respects wildcard + exact match", () => {
    expect(principalHas({ locals: { principal: user(["*"]) } }, "x:y")).toBe(true);
    expect(principalHas({ locals: { principal: user(["keys:manage"]) } }, "keys:manage")).toBe(true);
    expect(principalHas({ locals: { principal: user(["keys:read"]) } }, "keys:manage")).toBe(false);
  });
});

describe("resolvePermissions", () => {
  beforeEach(() => {
    h.permissionsFor.mockReset();
    delete process.env["AGENTOS_DEFAULT_ROLE"];
  });

  it("fills permissions from the role map for a fresh principal", async () => {
    h.permissionsFor.mockResolvedValue(["agents:read", "agents:write"]);
    const c = ctx({ principal: user([], ["agentos-editor"]) });
    resolvePermissions({} as never, c.res, c.next);
    await vi.waitFor(() => expect(c.passed()).toBe(true));
    expect(h.permissionsFor).toHaveBeenCalledWith(["agentos-editor"]);
    expect((c.res.locals.principal as Principal).permissions).toEqual(["agents:read", "agents:write"]);
  });

  it("short-circuits when permissions are already populated (no role lookup)", () => {
    const c = ctx({ principal: user(["*"]) });
    resolvePermissions({} as never, c.res, c.next);
    expect(c.passed()).toBe(true);
    expect(h.permissionsFor).not.toHaveBeenCalled();
  });

  it("401 when neither principal nor legacy user is present", () => {
    const c = ctx({});
    resolvePermissions({} as never, c.res, c.next);
    expect((c.getErr() as ApiError).status).toBe(401);
  });

  it("falls back to AGENTOS_DEFAULT_ROLE when the principal's roles grant nothing", async () => {
    process.env["AGENTOS_DEFAULT_ROLE"] = "agentos-viewer";
    h.permissionsFor.mockResolvedValueOnce([]).mockResolvedValueOnce(["agents:read", "obs:read"]);
    const c = ctx({ principal: user([], ["unmapped-okta-role"]) });
    resolvePermissions({} as never, c.res, c.next);
    await vi.waitFor(() => expect(c.passed()).toBe(true));
    expect(h.permissionsFor).toHaveBeenNthCalledWith(1, ["unmapped-okta-role"]);
    expect(h.permissionsFor).toHaveBeenNthCalledWith(2, ["agentos-viewer"]);
    expect((c.res.locals.principal as Principal).permissions).toEqual(["agents:read", "obs:read"]);
  });

  it("stays deny-by-default (empty) when no AGENTOS_DEFAULT_ROLE is set", async () => {
    h.permissionsFor.mockResolvedValue([]);
    const c = ctx({ principal: user([], ["unmapped"]) });
    resolvePermissions({} as never, c.res, c.next);
    await vi.waitFor(() => expect(c.passed()).toBe(true));
    expect((c.res.locals.principal as Principal).permissions).toEqual([]);
  });
});
