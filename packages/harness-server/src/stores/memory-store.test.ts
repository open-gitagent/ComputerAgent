import { describe, expect, it } from "vitest";
import { MemorySessionStore } from "./memory-store.js";

const key = (sessionId: string) => ({ projectKey: "test", sessionId });

describe("MemorySessionStore", () => {
  it("load() on a never-written key returns null", async () => {
    const store = new MemorySessionStore();
    expect(await store.load(key("nope"))).toBeNull();
  });

  it("append then load round-trips entries", async () => {
    const store = new MemorySessionStore();
    await store.append(key("s1"), [
      { type: "user", uuid: "a" },
      { type: "assistant", uuid: "b" },
    ]);
    const loaded = await store.load(key("s1"));
    expect(loaded).toEqual([
      { type: "user", uuid: "a" },
      { type: "assistant", uuid: "b" },
    ]);
  });

  it("appends accumulate across calls under the same sessionId", async () => {
    const store = new MemorySessionStore();
    await store.append(key("s1"), [{ type: "user", uuid: "a" }]);
    await store.append(key("s1"), [{ type: "assistant", uuid: "b" }]);
    const loaded = await store.load(key("s1"));
    expect(loaded).toHaveLength(2);
  });

  it("idempotent by entry.uuid — duplicate uuids are skipped", async () => {
    const store = new MemorySessionStore();
    await store.append(key("s1"), [{ type: "user", uuid: "a" }]);
    await store.append(key("s1"), [{ type: "user", uuid: "a" }]);
    expect(await store.size("s1")).toBe(1);
  });

  it("different sessionIds are isolated", async () => {
    const store = new MemorySessionStore();
    await store.append(key("alpha"), [{ type: "user", uuid: "a1" }]);
    await store.append(key("beta"), [{ type: "user", uuid: "b1" }]);
    expect((await store.load(key("alpha")))?.length).toBe(1);
    expect((await store.load(key("beta")))?.length).toBe(1);
  });

  it("entries without uuid are appended without dedup", async () => {
    const store = new MemorySessionStore();
    await store.append(key("s1"), [{ type: "marker" }, { type: "marker" }]);
    expect(await store.size("s1")).toBe(2);
  });

  it("load() returns a defensive copy — caller can mutate without affecting store", async () => {
    const store = new MemorySessionStore();
    await store.append(key("s1"), [{ type: "user", uuid: "a" }]);
    const loaded = await store.load(key("s1"));
    loaded!.push({ type: "injected", uuid: "x" });
    expect(await store.size("s1")).toBe(1);
  });
});
