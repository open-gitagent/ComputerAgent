import { describe, expect, it } from "vitest";
import type { SessionKey, SessionStore, SessionStoreEntry } from "@open-gitagent/protocol";
import { wrapValidatingStore } from "./validating-store.js";

class FakeStore implements SessionStore {
  loadResult: unknown[] | null = null;
  appendCalls: { key: SessionKey; entries: SessionStoreEntry[] }[] = [];
  async load(): Promise<SessionStoreEntry[] | null> {
    return this.loadResult as SessionStoreEntry[] | null;
  }
  async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
    this.appendCalls.push({ key, entries });
  }
}

const key = (sessionId: string) => ({ projectKey: "p", sessionId });

describe("wrapValidatingStore", () => {
  it("passes through valid entries unchanged and counts zero drops", async () => {
    const inner = new FakeStore();
    inner.loadResult = [
      { type: "user", uuid: "a", text: "hi" },
      { type: "assistant", uuid: "b", text: "yo" },
    ];
    const wrapped = wrapValidatingStore(inner);
    const out = await wrapped.load(key("s1"));
    expect(out).toEqual(inner.loadResult);
    expect(wrapped.stats.droppedCount).toBe(0);
  });

  it("drops null entries", async () => {
    const inner = new FakeStore();
    inner.loadResult = [
      { type: "user", text: "ok" },
      null,
      { type: "assistant", text: "ok2" },
    ];
    const wrapped = wrapValidatingStore(inner);
    const out = await wrapped.load(key("s1"));
    expect(out).toHaveLength(2);
    expect(wrapped.stats.droppedCount).toBe(1);
  });

  it("drops non-objects (numbers, strings, arrays)", async () => {
    const inner = new FakeStore();
    inner.loadResult = [
      { type: "user", text: "ok" },
      42,
      "not an entry",
      [1, 2, 3],
      { type: "assistant", text: "ok2" },
    ];
    const wrapped = wrapValidatingStore(inner);
    const out = await wrapped.load(key("s1"));
    expect(out).toHaveLength(2);
    expect(wrapped.stats.droppedCount).toBe(3);
  });

  it("drops entries missing the type field", async () => {
    const inner = new FakeStore();
    inner.loadResult = [
      { type: "user", text: "ok" },
      { uuid: "x", text: "no type field" },
      { type: "", text: "empty type string" },
      { type: 42, text: "non-string type" },
    ];
    const wrapped = wrapValidatingStore(inner);
    const out = await wrapped.load(key("s1"));
    expect(out).toHaveLength(1);
    expect(wrapped.stats.droppedCount).toBe(3);
  });

  it("returns null when inner returns null (no synthetic empty array)", async () => {
    const inner = new FakeStore();
    inner.loadResult = null;
    const wrapped = wrapValidatingStore(inner);
    expect(await wrapped.load(key("s1"))).toBeNull();
  });

  it("droppedCount accumulates across multiple load() calls", async () => {
    const inner = new FakeStore();
    const wrapped = wrapValidatingStore(inner);
    inner.loadResult = [{ type: "ok" }, null];
    await wrapped.load(key("s1"));
    inner.loadResult = [42, { type: "ok" }, "x"];
    await wrapped.load(key("s2"));
    expect(wrapped.stats.droppedCount).toBe(3); // 1 + 2
  });

  it("append() pass-through forwards verbatim to the inner store", async () => {
    const inner = new FakeStore();
    const wrapped = wrapValidatingStore(inner);
    const entries: SessionStoreEntry[] = [{ type: "u", uuid: "1" }];
    await wrapped.append(key("s1"), entries);
    expect(inner.appendCalls).toHaveLength(1);
    expect(inner.appendCalls[0]?.entries).toBe(entries);
  });

  it("forwards optional listSessions when the inner store implements it", async () => {
    class StoreWithList extends FakeStore {
      called = false;
      async listSessions(_p: string) {
        this.called = true;
        return [{ sessionId: "s1", mtime: 1 }];
      }
    }
    const inner = new StoreWithList();
    const wrapped = wrapValidatingStore(inner) as SessionStore & {
      listSessions?: (p: string) => Promise<unknown>;
    };
    expect(typeof wrapped.listSessions).toBe("function");
    await wrapped.listSessions!("p");
    expect(inner.called).toBe(true);
  });
});
