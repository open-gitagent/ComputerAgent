// Guards the RBAC identity fields in the query-builder whitelist. The obs UI's
// Group/Actor dropdowns hit GET /fields/:name/values, which 404s unless the
// field is in FIELDS. These entries must also map to the correct
// `computeragent.*` span attributes (ClickHouse) / NRQL paths, or the dropdowns
// + the implicit group_id/actor_id eq-filters would silently match nothing.

import { describe, expect, it } from "vitest";
import { FIELDS } from "./fields.js";

describe("FIELDS — RBAC identity fields", () => {
  const cases: Array<{ key: string; sqlExpr: string; nrqlAttr: string }> = [
    { key: "group_id", sqlExpr: "SpanAttributes['computeragent.group.id']", nrqlAttr: "computeragent.group.id" },
    { key: "owner_id", sqlExpr: "SpanAttributes['computeragent.owner.id']", nrqlAttr: "computeragent.owner.id" },
    { key: "actor_id", sqlExpr: "SpanAttributes['computeragent.actor.id']", nrqlAttr: "computeragent.actor.id" },
  ];

  for (const c of cases) {
    it(`registers ${c.key} mapped to the right span attribute`, () => {
      const def = FIELDS[c.key];
      expect(def, `${c.key} must be in the FIELDS whitelist`).toBeDefined();
      expect(def!.sqlExpr).toBe(c.sqlExpr);
      expect(def!.nrqlAttr).toBe(c.nrqlAttr);
      // The dropdowns filter by equality + membership; autocomplete needs string type.
      expect(def!.type).toBe("string");
      expect(def!.ops).toContain("eq");
      expect(def!.ops).toContain("in");
    });
  }
});
