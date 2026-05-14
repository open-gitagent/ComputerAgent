import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSessionStore } from "./file-store.js";

const key = (sessionId: string) => ({ projectKey: "test", sessionId });

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "session-store-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("FileSessionStore", () => {
  it("load() on a never-written key returns null", async () => {
    const store = new FileSessionStore({ root });
    expect(await store.load(key("nope"))).toBeNull();
  });

  it("append then load round-trips entries", async () => {
    const store = new FileSessionStore({ root });
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
    const store = new FileSessionStore({ root });
    await store.append(key("s1"), [{ type: "user", uuid: "a" }]);
    await store.append(key("s1"), [{ type: "assistant", uuid: "b" }]);
    const loaded = await store.load(key("s1"));
    expect(loaded?.length).toBe(2);
  });

  it("idempotent by entry.uuid across appends", async () => {
    const store = new FileSessionStore({ root });
    await store.append(key("s1"), [{ type: "user", uuid: "a" }]);
    await store.append(key("s1"), [{ type: "user", uuid: "a" }]);
    expect((await store.load(key("s1")))?.length).toBe(1);
  });

  it("traversal characters in sessionId are neutralised by hashing the filename", async () => {
    const store = new FileSessionStore({ root });
    await store.append(key("../../etc/passwd"), [{ type: "marker" }]);
    const files = await readdir(root);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^[0-9a-f]{32}\.jsonl$/);
    // No traversal happened — the file landed inside the root.
    expect(files[0]).not.toContain("..");
  });

  it("two different sessionIds write to two different files", async () => {
    const store = new FileSessionStore({ root });
    await store.append(key("alpha"), [{ type: "x" }]);
    await store.append(key("beta"), [{ type: "x" }]);
    const files = await readdir(root);
    expect(files).toHaveLength(2);
  });

  it("survives across two store instances against the same root (the resume scenario)", async () => {
    const a = new FileSessionStore({ root });
    await a.append(key("s1"), [{ type: "user", uuid: "a", text: "remember 47" }]);
    // Simulate process restart: brand new store instance, same root.
    const b = new FileSessionStore({ root });
    const loaded = await b.load(key("s1"));
    expect(loaded).toEqual([{ type: "user", uuid: "a", text: "remember 47" }]);
  });

  it("constructor rejects empty root", () => {
    expect(() => new FileSessionStore({ root: "" })).toThrow();
  });

  it("creates the root directory on first append if missing", async () => {
    const nested = join(root, "deeper", "still");
    const store = new FileSessionStore({ root: nested });
    await store.append(key("s1"), [{ type: "x" }]);
    const files = await readdir(nested);
    expect(files).toHaveLength(1);
  });
});
