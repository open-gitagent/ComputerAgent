// NRQL query-builder tests. Verifies that the WHERE clause / list / trace-list
// builders emit syntactically reasonable NRQL with the right placeholders and
// param map, and that the placeholders render correctly when passed to
// renderNrql.

import { describe, expect, it } from "vitest";

import {
  BadQueryError,
  buildNrqlListQuery,
  buildNrqlTimeWindow,
  buildNrqlTraceListQuery,
  buildNrqlWhere,
  type Query,
} from "./query.js";
import { renderNrql } from "./new-relic.js";

describe("buildNrqlTimeWindow", () => {
  it("emits SINCE + UNTIL with Timestamp params", () => {
    const { clause, params } = buildNrqlTimeWindow({
      from: "2024-06-01T00:00:00Z",
      to: "2024-06-02T00:00:00Z",
    });
    expect(clause).toBe("SINCE {t_from:Timestamp} UNTIL {t_to:Timestamp}");
    expect(params["t_from"]).toBeInstanceOf(Date);
    expect(params["t_to"]).toBeInstanceOf(Date);
  });

  it("emits empty clause when both bounds are absent", () => {
    const { clause, params } = buildNrqlTimeWindow({});
    expect(clause).toBe("");
    expect(params).toEqual({});
  });

  it("includes only the bound that's set", () => {
    const { clause } = buildNrqlTimeWindow({ from: "now-1h" });
    expect(clause).toBe("SINCE {t_from:Timestamp}");
  });
});

describe("buildNrqlWhere — operators", () => {
  it("eq", () => {
    const { where, params } = buildNrqlWhere({
      filters: [{ field: "agent", op: "eq", value: "router" }],
    });
    expect(where).toBe("WHERE `gen_ai.agent.name` = {p0:String}");
    expect(params).toEqual({ p0: "router" });
  });

  it("neq", () => {
    const { where } = buildNrqlWhere({
      filters: [{ field: "model", op: "neq", value: "haiku" }],
    });
    expect(where).toContain("`gen_ai.request.model` != {p0:String}");
  });

  it("gt / lt / gte / lte", () => {
    const { where, params } = buildNrqlWhere({
      filters: [
        { field: "duration_ms", op: "gt", value: 100 },
        { field: "duration_ms", op: "lte", value: 500 },
      ],
    });
    expect(where).toContain("`duration.ms` > {p0:Float64}");
    expect(where).toContain("`duration.ms` <= {p1:Float64}");
    expect(params).toEqual({ p0: 100, p1: 500 });
  });

  it("in / not_in", () => {
    const { where, params } = buildNrqlWhere({
      filters: [{ field: "agent", op: "in", value: ["a", "b"] }],
    });
    expect(where).toContain("`gen_ai.agent.name` IN {p0:Array(String)}");
    expect(params).toEqual({ p0: ["a", "b"] });
  });

  it("contains becomes LIKE with % wildcards", () => {
    const { where, params } = buildNrqlWhere({
      filters: [{ field: "tool", op: "contains", value: "read" }],
    });
    expect(where).toContain("`gen_ai.tool.name` LIKE {p0:String}");
    expect(params).toEqual({ p0: "%read%" });
  });

  it("exists translates to IS NOT NULL + != ''", () => {
    const { where, params } = buildNrqlWhere({
      filters: [{ field: "agent", op: "exists" }],
    });
    expect(where).toContain("`gen_ai.agent.name` IS NOT NULL");
    expect(where).toContain("`gen_ai.agent.name` != ''");
    expect(params).toEqual({});
  });

  it("multiple filters are AND-joined", () => {
    const { where } = buildNrqlWhere({
      filters: [
        { field: "agent", op: "eq", value: "router" },
        { field: "duration_ms", op: "gt", value: 100 },
      ],
    });
    expect(where).toBe(
      "WHERE `gen_ai.agent.name` = {p0:String} AND `duration.ms` > {p1:Float64}",
    );
  });

  it("returns empty WHERE when no filters", () => {
    const { where, params } = buildNrqlWhere({});
    expect(where).toBe("");
    expect(params).toEqual({});
  });

  it("rejects unknown field", () => {
    expect(() =>
      buildNrqlWhere({ filters: [{ field: "nope", op: "eq", value: "x" }] }),
    ).toThrow(BadQueryError);
  });

  it("rejects unsupported operator for a field", () => {
    // `agent` doesn't support `gt`.
    expect(() =>
      buildNrqlWhere({ filters: [{ field: "agent", op: "gt", value: 1 }] }),
    ).toThrow(/does not support op/);
  });
});

describe("buildNrqlWhere — round-trip with renderNrql", () => {
  it("produces a fully-substituted NRQL fragment", () => {
    const { where, params } = buildNrqlWhere({
      filters: [
        { field: "agent", op: "eq", value: "router" },
        { field: "model", op: "in", value: ["sonnet-4", "haiku"] },
        { field: "duration_ms", op: "lt", value: 1000 },
      ],
    });
    const rendered = renderNrql(where, params);
    expect(rendered).toBe(
      "WHERE `gen_ai.agent.name` = 'router' AND `gen_ai.request.model` IN ('sonnet-4', 'haiku') AND `duration.ms` < 1000",
    );
  });
});

describe("buildNrqlListQuery", () => {
  it("targets the Span event with all the canonical aliases", () => {
    const { nrql } = buildNrqlListQuery({});
    expect(nrql).toContain("FROM Span");
    expect(nrql).toContain("trace.id                            AS TraceId");
    expect(nrql).toContain("`gen_ai.agent.name`               AS agent");
    expect(nrql).toContain("`computeragent.usage.cost_usd`    AS cost_usd");
  });

  it("applies the limit (clamped to 1000)", () => {
    expect(buildNrqlListQuery({ limit: 9999 }).nrql).toContain("LIMIT 1000");
    expect(buildNrqlListQuery({ limit: 50 }).nrql).toContain("LIMIT 50");
    expect(buildNrqlListQuery({ limit: 0 }).nrql).toContain("LIMIT 1");
  });

  it("translates orderBy to the NRQL attribute", () => {
    expect(buildNrqlListQuery({ orderBy: "cost_usd", orderDir: "asc" }).nrql).toContain(
      "ORDER BY `computeragent.usage.cost_usd` ASC",
    );
  });

  it("interleaves WHERE and SINCE/UNTIL", () => {
    const q: Query = {
      filters: [{ field: "agent", op: "eq", value: "router" }],
      from: "now-1h",
      to: "now",
    };
    const { nrql } = buildNrqlListQuery(q);
    expect(nrql).toMatch(/WHERE .*\n\s*SINCE/s);
  });
});

describe("buildNrqlTraceListQuery", () => {
  it("FACETs on trace.id and aggregates with latest()/sum()/count()", () => {
    const { nrql } = buildNrqlTraceListQuery({});
    // NRQL doesn't allow aliasing the FACET attribute — single-dim FACET
    // auto-names its result column `facet`, which routes/obs-traces.ts
    // then renames to `TraceId`.
    expect(nrql).toContain("FACET trace.id");
    expect(nrql).not.toContain("FACET trace.id AS");
    expect(nrql).toContain("latest(name)");
    expect(nrql).toContain("sum(`computeragent.usage.cost_usd`)");
    expect(nrql).toContain("filter(count(*), WHERE otel.status_code");
  });

  it("clamps limit to 500", () => {
    expect(buildNrqlTraceListQuery({ limit: 9999 }).nrql).toContain("LIMIT 500");
  });

  it("propagates filters into WHERE", () => {
    const { nrql, params } = buildNrqlTraceListQuery({
      filters: [{ field: "model", op: "eq", value: "sonnet" }],
    });
    expect(nrql).toContain("WHERE `gen_ai.request.model` = {p0:String}");
    expect(params).toEqual({ p0: "sonnet" });
  });
});
