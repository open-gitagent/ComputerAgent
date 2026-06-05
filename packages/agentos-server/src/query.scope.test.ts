// RBAC owner-scope tests for the trace query builders. Verifies that
// `ownerScopeFor` resolves the right scope per principal, that the scope clause
// renders correctly for both backends, and that buildWhere/buildNrqlWhere append
// the mandatory `(owner = me OR group IN myGroups)` predicate.

import { describe, expect, it } from "vitest";

import {
  ownerScopeFor,
  clickhouseScopeClause,
  nrqlScopeClause,
  buildWhere,
  buildNrqlWhere,
  type OwnerScope,
} from "./query.js";
import type { Principal } from "./auth/principal.js";

function principal(over: Partial<Principal>): Principal {
  return {
    id: "user-1",
    kind: "user",
    roles: [],
    groups: [],
    permissions: [],
    source: "oidc",
    ...over,
  };
}

describe("ownerScopeFor", () => {
  it("returns undefined for superusers (wildcard permission) — unrestricted", () => {
    const p = principal({ permissions: ["*"] });
    expect(ownerScopeFor(p)).toBeUndefined();
  });

  it("scopes a normal principal to its own id + groups", () => {
    const p = principal({ id: "sub-42", groups: ["team-a", "team-b"], permissions: ["obs:read"] });
    expect(ownerScopeFor(p)).toEqual({ ownerId: "sub-42", groups: ["team-a", "team-b"] });
  });

  it("returns a deny-all sentinel for a missing principal", () => {
    const scope = ownerScopeFor(undefined);
    expect(scope).toBeDefined();
    expect(scope!.groups).toEqual([]);
    // The sentinel owner id must not be a realistic principal id.
    expect(scope!.ownerId).not.toBe("");
  });
});

describe("clickhouseScopeClause", () => {
  it("renders owner OR group IN when groups are present", () => {
    const params: Record<string, unknown> = {};
    const clause = clickhouseScopeClause({ ownerId: "me", groups: ["g1", "g2"] }, params);
    expect(clause).toBe(
      "(SpanAttributes['computeragent.owner.id'] = {scope_owner:String} OR " +
        "SpanAttributes['computeragent.group.id'] IN ({scope_groups:Array(String)}))",
    );
    expect(params).toEqual({ scope_owner: "me", scope_groups: ["g1", "g2"] });
  });

  it("renders owner-only (no group branch) when groups are empty", () => {
    const params: Record<string, unknown> = {};
    const clause = clickhouseScopeClause({ ownerId: "me", groups: [] }, params);
    expect(clause).toBe("(SpanAttributes['computeragent.owner.id'] = {scope_owner:String})");
    expect(params).toEqual({ scope_owner: "me" });
  });

  it("renders nothing for an undefined scope (superuser)", () => {
    const params: Record<string, unknown> = {};
    expect(clickhouseScopeClause(undefined, params)).toBe("");
    expect(params).toEqual({});
  });
});

describe("nrqlScopeClause", () => {
  it("renders owner OR group IN when groups are present", () => {
    const params: Record<string, unknown> = {};
    const clause = nrqlScopeClause({ ownerId: "me", groups: ["g1"] }, params);
    expect(clause).toBe(
      "(`computeragent.owner.id` = {scope_owner:String} OR " +
        "`computeragent.group.id` IN {scope_groups:Array(String)})",
    );
    expect(params).toEqual({ scope_owner: "me", scope_groups: ["g1"] });
  });

  it("renders nothing for an undefined scope", () => {
    const params: Record<string, unknown> = {};
    expect(nrqlScopeClause(undefined, params)).toBe("");
  });
});

describe("buildWhere / buildNrqlWhere — scope integration", () => {
  const scope: OwnerScope = { ownerId: "sub-9", groups: ["team-x"] };

  it("ClickHouse: appends the scope clause AND-ed after filters", () => {
    const { where, params } = buildWhere({
      filters: [{ field: "agent", op: "eq", value: "router" }],
      scope,
    });
    expect(where).toContain("SpanAttributes['gen_ai.agent.name'] = {p0:String}");
    expect(where).toContain(
      "AND (SpanAttributes['computeragent.owner.id'] = {scope_owner:String} OR " +
        "SpanAttributes['computeragent.group.id'] IN ({scope_groups:Array(String)}))",
    );
    expect(params["scope_owner"]).toBe("sub-9");
    expect(params["scope_groups"]).toEqual(["team-x"]);
  });

  it("ClickHouse: scope-only query still emits a WHERE", () => {
    const { where } = buildWhere({ scope });
    expect(where.startsWith("WHERE (")).toBe(true);
  });

  it("ClickHouse: no scope → no scope clause", () => {
    const { where, params } = buildWhere({ filters: [{ field: "agent", op: "eq", value: "x" }] });
    expect(where).not.toContain("computeragent.owner.id");
    expect(params["scope_owner"]).toBeUndefined();
  });

  it("NRQL: appends the scope clause AND-ed after filters", () => {
    const { where, params } = buildNrqlWhere({
      filters: [{ field: "agent", op: "eq", value: "router" }],
      scope,
    });
    expect(where).toContain("`gen_ai.agent.name` = {p0:String}");
    expect(where).toContain(
      "AND (`computeragent.owner.id` = {scope_owner:String} OR " +
        "`computeragent.group.id` IN {scope_groups:Array(String)})",
    );
    expect(params["scope_owner"]).toBe("sub-9");
  });
});
