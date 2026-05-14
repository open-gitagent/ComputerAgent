import { describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest";
import { MongoClient } from "mongodb";
import { MongoSessionStore } from "./mongo-store.js";

/**
 * Integration tests against a live MongoDB. Skipped automatically when
 * `MONGO_URL` is not set in the environment — keeps CI green for forks
 * without a Mongo cluster while still being load-bearing when run with
 * credentials.
 *
 * Each test uses a unique database name (`ca_test_<random>`) and drops
 * it on teardown so concurrent runs don't collide.
 */
const url = process.env.MONGO_URL;
const describeMongo = url ? describe : describe.skip;

describeMongo("MongoSessionStore (live)", () => {
  let cleanupClient: MongoClient | null = null;
  let dbName: string;
  let store: MongoSessionStore;

  beforeAll(async () => {
    cleanupClient = new MongoClient(url!);
    await cleanupClient.connect();
  });

  afterAll(async () => {
    if (cleanupClient) await cleanupClient.close();
  });

  beforeEach(async () => {
    dbName = `ca_test_${Math.random().toString(36).slice(2, 10)}`;
    store = new MongoSessionStore({ url: url!, database: dbName });
  });

  const cleanup = async () => {
    try { await cleanupClient?.db(dbName).dropDatabase(); } catch { /* ignore */ }
    await store.close();
  };

  it("load() on a never-written key returns null", async () => {
    try {
      const r = await store.load({ projectKey: "p", sessionId: "nope" });
      expect(r).toBeNull();
    } finally { await cleanup(); }
  });

  it("append then load round-trips entries", async () => {
    try {
      const key = { projectKey: "p", sessionId: "s1" };
      await store.append(key, [
        { type: "user", uuid: "a", text: "hi" },
        { type: "assistant", uuid: "b", text: "hello" },
      ]);
      const loaded = await store.load(key);
      expect(loaded).toHaveLength(2);
      expect((loaded![0] as { uuid: string }).uuid).toBe("a");
    } finally { await cleanup(); }
  });

  it("appends accumulate across calls", async () => {
    try {
      const key = { projectKey: "p", sessionId: "s1" };
      await store.append(key, [{ type: "u", uuid: "a" }]);
      await store.append(key, [{ type: "u", uuid: "b" }]);
      expect(await store.size("s1")).toBe(2);
    } finally { await cleanup(); }
  });

  it("idempotent by entry.uuid", async () => {
    try {
      const key = { projectKey: "p", sessionId: "s1" };
      await store.append(key, [{ type: "u", uuid: "a" }]);
      await store.append(key, [{ type: "u", uuid: "a" }]);
      expect(await store.size("s1")).toBe(1);
    } finally { await cleanup(); }
  });

  it("survives across two MongoSessionStore instances (the resume scenario)", async () => {
    try {
      const a = store;
      const key = { projectKey: "p", sessionId: "s1" };
      await a.append(key, [{ type: "u", uuid: "a", text: "remember 47" }]);
      const b = new MongoSessionStore({ url: url!, database: dbName });
      const loaded = await b.load(key);
      expect(loaded).toEqual([{ type: "u", uuid: "a", text: "remember 47" }]);
      await b.close();
    } finally { await cleanup(); }
  });

  it("different sessionIds isolated under the same database", async () => {
    try {
      await store.append({ projectKey: "p", sessionId: "alpha" }, [{ type: "u", uuid: "1" }]);
      await store.append({ projectKey: "p", sessionId: "beta" }, [{ type: "u", uuid: "2" }]);
      expect(await store.size("alpha")).toBe(1);
      expect(await store.size("beta")).toBe(1);
    } finally { await cleanup(); }
  });

  it("listSessions returns recently-written sessions for a projectKey", async () => {
    try {
      await store.append({ projectKey: "demo", sessionId: "x" }, [{ type: "u" }]);
      await store.append({ projectKey: "demo", sessionId: "y" }, [{ type: "u" }]);
      const sessions = await store.listSessions("demo");
      expect(sessions.length).toBeGreaterThanOrEqual(2);
    } finally { await cleanup(); }
  });
});

describe("MongoSessionStore (offline contract)", () => {
  it("constructor rejects empty url", () => {
    expect(() => new MongoSessionStore({ url: "" })).toThrow();
  });
});
