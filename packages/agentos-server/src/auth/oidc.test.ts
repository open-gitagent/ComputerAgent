// Unit tests for claimsToPrincipal — the claim → Principal mapping, including
// the configurable role/group claim paths and full-path group normalization.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { claimsToPrincipal } from "./oidc.js";
import type { JWTPayload } from "jose";

beforeEach(() => {
  delete process.env["OIDC_ROLES_CLAIM"];
  delete process.env["OIDC_GROUPS_CLAIM"];
});
afterEach(() => {
  delete process.env["OIDC_ROLES_CLAIM"];
  delete process.env["OIDC_GROUPS_CLAIM"];
});

describe("claimsToPrincipal", () => {
  it("reads realm_access.roles + groups by default and strips a leading slash", () => {
    const p = claimsToPrincipal({
      sub: "s1",
      email: "a@x.io",
      name: "Alice",
      realm_access: { roles: ["agentos-editor"] },
      groups: ["/agentos-editors"],
    } as unknown as JWTPayload);
    expect(p).toMatchObject({ id: "s1", kind: "user", email: "a@x.io", displayName: "Alice", roles: ["agentos-editor"], source: "oidc" });
    expect(p.groups).toEqual(["agentos-editors"]);
    expect(p.permissions).toEqual([]);
  });

  it("honors OIDC_ROLES_CLAIM / OIDC_GROUPS_CLAIM overrides (dotted paths)", () => {
    process.env["OIDC_ROLES_CLAIM"] = "resource_access.agentos.roles";
    process.env["OIDC_GROUPS_CLAIM"] = "groups_custom";
    const p = claimsToPrincipal({
      sub: "s2",
      resource_access: { agentos: { roles: ["agentos-admin"] } },
      groups_custom: ["admins"],
    } as unknown as JWTPayload);
    expect(p.roles).toEqual(["agentos-admin"]);
    expect(p.groups).toEqual(["admins"]);
  });

  it("falls back to preferred_username and tolerates missing role/group claims", () => {
    const p = claimsToPrincipal({ sub: "s3", preferred_username: "bob" } as unknown as JWTPayload);
    expect(p.displayName).toBe("bob");
    expect(p.roles).toEqual([]);
    expect(p.groups).toEqual([]);
  });
});
