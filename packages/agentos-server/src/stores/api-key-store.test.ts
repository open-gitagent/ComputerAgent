// Unit test for apiKeyStore. Mocks `../mongo.js` with an in-memory fake of the
// `api_keys` collection (no real Mongo), so the real create/verify/list/revoke
// run against it. Verifies: plaintext format + once-only return, hash never
// crosses the boundary, prefix/expiry/revoke semantics, and pepper sensitivity.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  function clone(v: any): any {
    if (v instanceof Date) return new Date(v.getTime());
    if (Array.isArray(v)) return v.map(clone);
    if (v && typeof v === "object") {
      const o: any = {};
      for (const k of Object.keys(v)) o[k] = clone(v[k]);
      return o;
    }
    return v;
  }
  const matches = (doc: any, filter: any) =>
    Object.entries(filter ?? {}).every(([k, val]) => {
      const dv = doc[k];
      if (val instanceof Date && dv instanceof Date) return dv.getTime() === val.getTime();
      return dv === val;
    });

  class FakeCollection {
    docs = new Map<string, any>();
    async createIndex() { return "idx"; }
    async insertOne(doc: any) {
      this.docs.set(doc._id, clone(doc));
      return { insertedId: doc._id };
    }
    async findOne(filter: any) {
      for (const d of this.docs.values()) if (matches(d, filter)) return clone(d);
      return null;
    }
    find(filter: any = {}) {
      const all = [...this.docs.values()].filter((d) => matches(d, filter)).map(clone);
      return {
        sort: (spec: any) => {
          const [[k, dir]] = Object.entries(spec) as [[string, number]];
          all.sort((a, b) => {
            const av = a[k] instanceof Date ? a[k].getTime() : a[k];
            const bv = b[k] instanceof Date ? b[k].getTime() : b[k];
            return av < bv ? -dir : av > bv ? dir : 0;
          });
          return { toArray: async () => all };
        },
      };
    }
    async updateOne(filter: any, update: any) {
      for (const d of this.docs.values()) {
        if (matches(d, filter)) {
          if (update.$set) Object.assign(d, clone(update.$set));
          return { matchedCount: 1, modifiedCount: 1 };
        }
      }
      return { matchedCount: 0, modifiedCount: 0 };
    }
  }

  const coll = new FakeCollection();
  const fakeDb = { collection: () => coll };
  return { coll, fakeDb };
});

vi.mock("../mongo.js", () => ({ getDb: async () => h.fakeDb }));

import { apiKeyStore, KEY_PREFIX } from "./api-key-store.js";

beforeEach(() => {
  h.coll.docs.clear();
  delete process.env["AGENTOS_API_KEY_PEPPER"];
});
afterEach(() => {
  delete process.env["AGENTOS_API_KEY_PEPPER"];
});

describe("apiKeyStore", () => {
  it("create returns a cak_ plaintext once and a redacted doc (no hash)", async () => {
    const created = await apiKeyStore.create({ label: "qa", createdBy: "alice" });
    expect(created.plaintext.startsWith(KEY_PREFIX)).toBe(true);
    expect(created.plaintext.length).toBeGreaterThan(40);
    expect((created.doc as any).hash).toBeUndefined();
    expect(created.doc.prefix).toBe(created.plaintext.slice(0, 8));
    expect(created.doc.last4).toBe(created.plaintext.slice(-4));
    expect(created.doc.scopes).toEqual(["*"]);
    // The stored doc DOES carry a hash, but the plaintext is never stored.
    const stored = [...h.coll.docs.values()][0];
    expect(stored.hash).toBeTruthy();
    expect(JSON.stringify(stored)).not.toContain(created.plaintext);
  });

  it("verify accepts a live key and rejects wrong / non-key inputs", async () => {
    const { plaintext } = await apiKeyStore.create({ label: "k", createdBy: "a" });
    const ok = await apiKeyStore.verify(plaintext);
    expect(ok?.active).toBe(true);
    expect(ok?.scopes).toEqual(["*"]);
    expect(await apiKeyStore.verify(KEY_PREFIX + "wrong")).toBeNull();
    expect(await apiKeyStore.verify("not-a-key")).toBeNull();
    expect(await apiKeyStore.verify("")).toBeNull();
  });

  it("verify rejects an expired key", async () => {
    const past = new Date(Date.now() - 60_000);
    const { plaintext } = await apiKeyStore.create({ label: "k", createdBy: "a", expiresAt: past });
    expect(await apiKeyStore.verify(plaintext)).toBeNull();
  });

  it("revoke is idempotent and kills the key", async () => {
    const { plaintext, doc } = await apiKeyStore.create({ label: "k", createdBy: "a" });
    expect(await apiKeyStore.verify(plaintext)).not.toBeNull();
    expect(await apiKeyStore.revoke(doc._id)).toBe(true);
    expect(await apiKeyStore.verify(plaintext)).toBeNull();
    expect(await apiKeyStore.revoke(doc._id)).toBe(false); // already revoked
  });

  it("list never includes the hash", async () => {
    await apiKeyStore.create({ label: "one", createdBy: "a" });
    await apiKeyStore.create({ label: "two", createdBy: "a" });
    const list = await apiKeyStore.list();
    expect(list.length).toBe(2);
    for (const k of list) expect((k as any).hash).toBeUndefined();
  });

  it("a pepper-created key does not verify once the pepper is removed", async () => {
    process.env["AGENTOS_API_KEY_PEPPER"] = "pepper-xyz";
    const { plaintext } = await apiKeyStore.create({ label: "k", createdBy: "a" });
    expect(await apiKeyStore.verify(plaintext)).not.toBeNull();
    delete process.env["AGENTOS_API_KEY_PEPPER"];
    expect(await apiKeyStore.verify(plaintext)).toBeNull(); // hash mismatch
  });
});
