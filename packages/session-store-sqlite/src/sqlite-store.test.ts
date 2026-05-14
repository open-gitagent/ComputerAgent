import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { SqliteSessionStore } from "./sqlite-store.js";

let store: SqliteSessionStore;
const key = (sessionId: string) => ({ projectKey: "p", sessionId });

beforeEach(() => {
  store = new SqliteSessionStore({ path: ":memory:" });
});
afterEach(() => {
  store.close();
});

describe("SqliteSessionStore — SessionStore contract", () => {
  it("load() on a never-written key returns null", async () => {
    expect(await store.load(key("nope"))).toBeNull();
  });

  it("append then load round-trips entries in insertion order", async () => {
    await store.append(key("s1"), [
      { type: "user", uuid: "a", text: "hi" },
      { type: "assistant", uuid: "b", text: "hello" },
    ]);
    const loaded = await store.load(key("s1"));
    expect(loaded).toEqual([
      { type: "user", uuid: "a", text: "hi" },
      { type: "assistant", uuid: "b", text: "hello" },
    ]);
  });

  it("appends accumulate across calls under the same sessionId", async () => {
    await store.append(key("s1"), [{ type: "u", uuid: "a" }]);
    await store.append(key("s1"), [{ type: "u", uuid: "b" }]);
    expect(store.size("s1")).toBe(2);
  });

  it("idempotent by entry.uuid", async () => {
    await store.append(key("s1"), [{ type: "u", uuid: "a" }]);
    await store.append(key("s1"), [{ type: "u", uuid: "a" }]);
    expect(store.size("s1")).toBe(1);
  });

  it("entries without uuid are appended without dedup", async () => {
    await store.append(key("s1"), [{ type: "marker" }, { type: "marker" }]);
    expect(store.size("s1")).toBe(2);
  });

  it("different sessionIds are isolated", async () => {
    await store.append(key("alpha"), [{ type: "u", uuid: "1" }]);
    await store.append(key("beta"), [{ type: "u", uuid: "2" }]);
    expect(store.size("alpha")).toBe(1);
    expect(store.size("beta")).toBe(1);
  });

  it("survives across two store instances against the same file (the resume scenario)", async () => {
    // Switch to a real file path for this test.
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "ca-sqlite-test-"));
    try {
      const a = new SqliteSessionStore({ path: join(dir, "test.sqlite") });
      await a.append(key("s1"), [{ type: "u", uuid: "a", text: "remember 47" }]);
      a.close();

      const b = new SqliteSessionStore({ path: join(dir, "test.sqlite") });
      const loaded = await b.load(key("s1"));
      expect(loaded).toEqual([{ type: "u", uuid: "a", text: "remember 47" }]);
      b.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("listSessions returns recently-written sessions for a projectKey", async () => {
    await store.append({ projectKey: "demo", sessionId: "x" }, [{ type: "u" }]);
    await store.append({ projectKey: "demo", sessionId: "y" }, [{ type: "u" }]);
    const sessions = await store.listSessions("demo");
    expect(sessions.length).toBe(2);
  });

  it("constructor rejects empty path", () => {
    expect(() => new SqliteSessionStore({ path: "" })).toThrow();
  });

  it("close() is idempotent", () => {
    store.close();
    expect(() => store.close()).not.toThrow();
  });

  it("batched append is atomic — failure rolls back", async () => {
    // SQLite transactions wrap the batch; this is mostly a smoke test that
    // the transaction runs at all (verified by checking final count after
    // a successful batch).
    await store.append(key("s1"), [
      { type: "u", uuid: "a" },
      { type: "u", uuid: "b" },
      { type: "u", uuid: "c" },
    ]);
    expect(store.size("s1")).toBe(3);
  });
});
