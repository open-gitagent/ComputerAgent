import { describe, expect, it } from "vitest";
import {
  DEFAULT_STORE_BUILDERS,
  resolveStore,
  type SessionStoreRegistry,
} from "./registry.js";
import { MemorySessionStore } from "./memory-store.js";
import { FileSessionStore } from "./file-store.js";

describe("SessionStore registry", () => {
  it("DEFAULT_STORE_BUILDERS includes memory and file", () => {
    expect(Object.keys(DEFAULT_STORE_BUILDERS).sort()).toEqual(["file", "memory"]);
  });

  it("resolves kind: 'memory' to a MemorySessionStore", () => {
    const store = resolveStore(DEFAULT_STORE_BUILDERS, { kind: "memory" });
    expect(store).toBeInstanceOf(MemorySessionStore);
  });

  it("resolves kind: 'file' to a FileSessionStore with given root", () => {
    const store = resolveStore(DEFAULT_STORE_BUILDERS, {
      kind: "file",
      options: { root: "/tmp/test-store" },
    });
    expect(store).toBeInstanceOf(FileSessionStore);
  });

  it("unknown kind throws BadRequest with UNKNOWN_STORE code + available list", () => {
    try {
      resolveStore(DEFAULT_STORE_BUILDERS, { kind: "nope" });
      expect.fail("should have thrown");
    } catch (err) {
      const e = err as { code?: string; status?: number; details?: { available?: string[] } };
      expect(e.code).toBe("UNKNOWN_STORE");
      expect(e.status).toBe(400);
      expect(e.details?.available?.sort()).toEqual(["file", "memory"]);
    }
  });

  it("user-supplied builder overrides a default kind", () => {
    let invocations = 0;
    const customMemory = new MemorySessionStore();
    const registry: SessionStoreRegistry = {
      ...DEFAULT_STORE_BUILDERS,
      memory: () => {
        invocations += 1;
        return customMemory;
      },
    };
    const store = resolveStore(registry, { kind: "memory" });
    expect(store).toBe(customMemory);
    expect(invocations).toBe(1);
  });

  it("user-supplied builder adds a new kind", () => {
    const fakeStore = new MemorySessionStore();
    const registry: SessionStoreRegistry = {
      ...DEFAULT_STORE_BUILDERS,
      mongo: () => fakeStore,
    };
    const store = resolveStore(registry, { kind: "mongo", options: { url: "mongodb://x" } });
    expect(store).toBe(fakeStore);
  });

  it("builder receives the options field verbatim", () => {
    let seen: unknown;
    const registry: SessionStoreRegistry = {
      ...DEFAULT_STORE_BUILDERS,
      probe: (opts) => {
        seen = opts;
        return new MemorySessionStore();
      },
    };
    resolveStore(registry, { kind: "probe", options: { a: 1, b: "x" } });
    expect(seen).toEqual({ a: 1, b: "x" });
  });
});
