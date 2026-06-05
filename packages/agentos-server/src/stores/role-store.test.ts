// Unit test for roleStore against an in-memory `roles` collection fake (no real
// Mongo). Covers seedDefaults idempotency, permissionsFor unions + live
// invalidation, permission-key validation, and builtin-delete protection.

import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => {
  class FakeCollection {
    docs = new Map<string, any>();
    async createIndex() {
      return "idx";
    }
    async insertOne(doc: any) {
      this.docs.set(doc._id, structuredClone(doc));
      return { insertedId: doc._id };
    }
    async findOne(filter: any) {
      const id = filter?._id;
      if (id !== undefined) return this.docs.has(id) ? structuredClone(this.docs.get(id)) : null;
      const first = [...this.docs.values()][0];
      return first ? structuredClone(first) : null;
    }
    find() {
      const all = [...this.docs.values()].map((d) => structuredClone(d));
      const toArray = async () => all;
      return { toArray, sort: () => ({ toArray }) };
    }
    async updateOne(filter: any, update: any, opts: any = {}) {
      const id = filter._id;
      const existed = this.docs.has(id);
      let doc = this.docs.get(id);
      if (!doc) {
        if (!opts.upsert) return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
        doc = { _id: id };
        this.docs.set(id, doc);
      }
      if (update.$setOnInsert && !existed) Object.assign(doc, structuredClone(update.$setOnInsert));
      if (update.$set) Object.assign(doc, structuredClone(update.$set));
      return { matchedCount: existed ? 1 : 0, modifiedCount: 1, upsertedCount: existed ? 0 : 1 };
    }
    async deleteOne(filter: any) {
      return { deletedCount: this.docs.delete(filter._id) ? 1 : 0 };
    }
  }
  const coll = new FakeCollection();
  return { coll, fakeDb: { collection: () => coll } };
});

vi.mock("../mongo.js", () => ({ getDb: async () => h.fakeDb }));

import { roleStore, RoleValidationError } from "./role-store.js";

beforeEach(() => {
  h.coll.docs.clear();
});

describe("roleStore", () => {
  it("seeds the three builtin roles idempotently and never clobbers edits", async () => {
    await roleStore.seedDefaults();
    const roles = await roleStore.list();
    expect(roles.map((r) => r._id).sort()).toEqual(["agentos-admin", "agentos-editor", "agentos-viewer"]);
    expect((await roleStore.get("agentos-admin"))?.permissions).toEqual(["*"]);

    // Edit a builtin, then re-seed — the edit must survive.
    await roleStore.update("agentos-viewer", { permissions: ["agents:read", "obs:read"] });
    await roleStore.seedDefaults();
    expect((await roleStore.get("agentos-viewer"))?.permissions).toEqual(["agents:read", "obs:read"]);
  });

  it("permissionsFor unions across roles and reflects edits immediately", async () => {
    await roleStore.seedDefaults();
    expect(await roleStore.permissionsFor(["agentos-admin"])).toEqual(["*"]);
    expect(await roleStore.permissionsFor(["nope"])).toEqual([]);

    const union = await roleStore.permissionsFor(["agentos-viewer", "agentos-editor"]);
    expect(union).toContain("agents:read");
    expect(union).toContain("agents:write");
    // de-duped union
    expect(union.filter((p) => p === "agents:read")).toHaveLength(1);

    await roleStore.update("agentos-viewer", { permissions: ["agents:read", "keys:manage"] });
    expect(await roleStore.permissionsFor(["agentos-viewer"])).toContain("keys:manage");
  });

  it("rejects unknown permission keys on create/update", async () => {
    await expect(roleStore.create({ name: "custom", permissions: ["bogus:perm"] })).rejects.toBeInstanceOf(RoleValidationError);
    await roleStore.seedDefaults();
    await expect(roleStore.update("agentos-editor", { permissions: ["nope"] })).rejects.toBeInstanceOf(RoleValidationError);
  });

  it("protects builtin roles from deletion; removes custom roles", async () => {
    await roleStore.seedDefaults();
    expect(await roleStore.remove("agentos-admin")).toBe("builtin");
    expect(await roleStore.remove("ghost")).toBe("not_found");
    await roleStore.create({ name: "ops", permissions: ["obs:read"] });
    expect(await roleStore.remove("ops")).toBe("deleted");
    expect(await roleStore.get("ops")).toBeNull();
  });
});
