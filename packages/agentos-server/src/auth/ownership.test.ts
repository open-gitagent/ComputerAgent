// Unit tests for the resource-ownership helpers (multi-tenancy).

import { describe, it, expect } from "vitest";
import { canRead, canWrite, pickOwnerGroup, isSuperuser } from "./ownership.js";
import type { Principal } from "./principal.js";

const user = (groups: string[], permissions: string[] = [], id = "u1"): Principal => ({
  id,
  kind: "user",
  roles: [],
  groups,
  permissions,
  source: "oidc",
});
const admin = user(["x"], ["*"], "admin1");

describe("isSuperuser", () => {
  it("is true only for the wildcard permission", () => {
    expect(isSuperuser(admin)).toBe(true);
    expect(isSuperuser(user(["x"], ["agents:read"]))).toBe(false);
    expect(isSuperuser(undefined)).toBe(false);
  });
});

describe("canRead (visibility / hard isolation)", () => {
  it("admins see everything", () => {
    expect(canRead(admin, { ownerGroup: "team-b", ownerUser: "someone" })).toBe(true);
  });
  it("group members see their group's resources", () => {
    expect(canRead(user(["team-a"]), { ownerGroup: "team-a", ownerUser: "x" })).toBe(true);
  });
  it("non-members cannot see other groups' resources", () => {
    expect(canRead(user(["team-a"]), { ownerGroup: "team-b", ownerUser: "x" })).toBe(false);
  });
  it("the creator sees their own resource (in any/no group)", () => {
    expect(canRead(user([], [], "alice"), { ownerGroup: null, ownerUser: "alice" })).toBe(true);
    expect(canRead(user(["team-a"], [], "alice"), { ownerGroup: "team-b", ownerUser: "alice" })).toBe(true);
  });
  it("unowned / other-owner resources are NOT visible to non-owners/non-admins", () => {
    expect(canRead(user(["team-a"], [], "bob"), { ownerGroup: null, ownerUser: "alice" })).toBe(false);
    expect(canRead(user([], [], "bob"), {})).toBe(false);
  });
});

describe("canWrite (mutate / delete)", () => {
  it("admins write everything", () => {
    expect(canWrite(admin, { ownerGroup: "team-b", ownerUser: "someone-else" })).toBe(true);
  });
  it("only the owner user may write", () => {
    expect(canWrite(user(["team-a"], [], "alice"), { ownerGroup: "team-a", ownerUser: "alice" })).toBe(true);
    expect(canWrite(user(["team-a"], [], "bob"), { ownerGroup: "team-a", ownerUser: "alice" })).toBe(false);
  });
  it("unowned resources are writable only by admins", () => {
    expect(canWrite(user(["team-a"], [], "alice"), { ownerGroup: null, ownerUser: null })).toBe(false);
    expect(canWrite(admin, {})).toBe(true);
  });
});

describe("pickOwnerGroup (create-time)", () => {
  it("defaults to the principal's first group when none requested", () => {
    expect(pickOwnerGroup(user(["team-a", "team-b"]), undefined)).toEqual({ ok: true, group: "team-a" });
  });
  it("allows a requested group the principal belongs to", () => {
    expect(pickOwnerGroup(user(["team-a", "team-b"]), "team-b")).toEqual({ ok: true, group: "team-b" });
  });
  it("rejects a group the principal is not a member of", () => {
    expect(pickOwnerGroup(user(["team-a"]), "team-b")).toEqual({ ok: false });
  });
  it("lets admins stamp any group", () => {
    expect(pickOwnerGroup(admin, "any-group")).toEqual({ ok: true, group: "any-group" });
  });
});
