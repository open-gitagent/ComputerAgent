// Unit tests for gitCredentialStore — in-memory Mongo fake (supports upsert /
// $setOnInsert / $in / deleteOne). Verifies: encrypted at rest, redacted across
// the boundary, upsert idempotency + rotation on (ownerGroup, host), and that
// resolve decrypts only for a matching group+host.

import { beforeEach, describe, expect, it } from "vitest";

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
  const matches = (doc: any, filter: any): boolean =>
    Object.entries(filter ?? {}).every(([k, val]) => {
      const dv = doc[k];
      if (val && typeof val === "object" && "$in" in (val as any)) return (val as any).$in.includes(dv);
      if (val instanceof Date && dv instanceof Date) return dv.getTime() === val.getTime();
      return dv === val;
    });

  class FakeCollection {
    docs = new Map<string, any>();
    async createIndex() { return "idx"; }
    async insertOne(doc: any) { this.docs.set(doc._id, clone(doc)); return { insertedId: doc._id }; }
    async findOne(filter: any) {
      for (const d of this.docs.values()) if (matches(d, filter)) return clone(d);
      return null;
    }
    find(filter: any = {}) {
      const all = [...this.docs.values()].filter((d) => matches(d, filter)).map(clone);
      const sort = (spec: any) => {
        const [[k, dir]] = Object.entries(spec) as [[string, number]];
        all.sort((a, b) => {
          const av = a[k] instanceof Date ? a[k].getTime() : a[k];
          const bv = b[k] instanceof Date ? b[k].getTime() : b[k];
          return av < bv ? -dir : av > bv ? dir : 0;
        });
        return { toArray: async () => all };
      };
      return { sort, toArray: async () => all };
    }
    async updateOne(filter: any, update: any, opts: any = {}) {
      for (const d of this.docs.values()) {
        if (matches(d, filter)) {
          if (update.$set) Object.assign(d, clone(update.$set));
          return { matchedCount: 1, modifiedCount: 1, upsertedCount: 0 };
        }
      }
      if (opts.upsert) {
        const doc: any = {};
        Object.assign(doc, clone(update.$setOnInsert ?? {}), clone(update.$set ?? {}));
        this.docs.set(doc._id, doc);
        return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1 };
      }
      return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
    }
    async deleteOne(filter: any) {
      for (const [id, d] of this.docs) if (matches(d, filter)) { this.docs.delete(id); return { deletedCount: 1 }; }
      return { deletedCount: 0 };
    }
  }
  const coll = new FakeCollection();
  return { coll, fakeDb: { collection: () => coll } };
});

import { vi } from "vitest";
vi.mock("../mongo.js", () => ({ getDb: async () => h.fakeDb }));

import { gitCredentialStore, normalizeGitHost } from "./git-credential-store.js";
import { resetKeyringForTests } from "../crypto/secret-box.js";

beforeEach(() => {
  h.coll.docs.clear();
  process.env["AGENTOS_CREDENTIALS_KEY"] = Buffer.alloc(32, 7).toString("base64");
  resetKeyringForTests();
});

describe("normalizeGitHost", () => {
  it("reduces any repo URL shape to a bare lowercased host", () => {
    expect(normalizeGitHost("https://github.com/o/r")).toBe("github.com");
    expect(normalizeGitHost("github.com/o/r")).toBe("github.com");
    expect(normalizeGitHost("git@github.com:o/r.git")).toBe("github.com");
    expect(normalizeGitHost("ssh://git@GitHub.com/o/r")).toBe("github.com");
    expect(normalizeGitHost("gitlab.example.com:443")).toBe("gitlab.example.com");
  });
});

describe("gitCredentialStore", () => {
  it("encrypts at rest and never returns the secret across the boundary", async () => {
    const red = await gitCredentialStore.upsert({
      host: "github.com", ownerGroup: "Platform", ownerUser: "u1",
      label: "plat", plaintextToken: "ghp_abcd1234", createdBy: "u1",
    });
    expect((red as any).secret).toBeUndefined();
    expect(red.hasSecret).toBe(true);
    expect(red.last4).toBe("1234");
    const stored = [...h.coll.docs.values()][0];
    expect(JSON.stringify(stored.secret)).not.toContain("ghp_abcd1234"); // encrypted
  });

  it("is unique on (ownerGroup, host): re-upsert rotates, never duplicates", async () => {
    await gitCredentialStore.upsert({ host: "github.com", ownerGroup: "Platform", ownerUser: "u1", label: "v1", plaintextToken: "tok-one", createdBy: "u1" });
    const first = [...h.coll.docs.values()][0];
    await gitCredentialStore.upsert({ host: "github.com", ownerGroup: "Platform", ownerUser: "u1", label: "v2", plaintextToken: "tok-two", createdBy: "u1" });
    expect(h.coll.docs.size).toBe(1); // same (group, host) → same doc
    const after = [...h.coll.docs.values()][0];
    expect(after._id).toBe(first._id);
    expect(after.rotatedAt).toBeTruthy();
    const r = await gitCredentialStore.resolve({ ownerGroups: ["Platform"], host: "github.com" });
    expect(r?.token).toBe("tok-two");
  });

  it("resolve returns the plaintext only for a matching group + host", async () => {
    await gitCredentialStore.upsert({ host: "github.com", ownerGroup: "Platform", ownerUser: "u1", label: "p", plaintextToken: "secret-pat", createdBy: "u1" });
    expect((await gitCredentialStore.resolve({ ownerGroups: ["Platform"], host: "https://github.com/o/r" }))?.token).toBe("secret-pat");
    expect(await gitCredentialStore.resolve({ ownerGroups: ["OtherTeam"], host: "github.com" })).toBeNull(); // wrong group
    expect(await gitCredentialStore.resolve({ ownerGroups: ["Platform"], host: "gitlab.com" })).toBeNull(); // wrong host
    expect(await gitCredentialStore.resolve({ ownerGroups: [], host: "github.com" })).toBeNull(); // no groups
  });

  it("list redacts and remove deletes", async () => {
    await gitCredentialStore.upsert({ host: "github.com", ownerGroup: "Platform", ownerUser: "u1", label: "p", plaintextToken: "t", createdBy: "u1" });
    const list = await gitCredentialStore.list();
    expect(list).toHaveLength(1);
    expect((list[0] as any).secret).toBeUndefined();
    expect(await gitCredentialStore.remove(list[0]!._id)).toBe(true);
    expect(await gitCredentialStore.list()).toHaveLength(0);
  });
});
