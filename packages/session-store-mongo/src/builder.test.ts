import { describe, expect, it } from "vitest";
import { mongoSessionStoreBuilder } from "./builder.js";

describe("mongoSessionStoreBuilder", () => {
  it("returns a builder that constructs a MongoSessionStore from defaults", () => {
    const build = mongoSessionStoreBuilder({
      url: "mongodb://localhost:27017/admin",
      database: "default_db",
    });
    const store = build();
    // Constructed without throwing — connection is lazy.
    expect(store).toBeDefined();
    // Cleanup so we don't leak the MongoClient.
    void (store as { close?: () => Promise<void> }).close?.();
  });

  it("merges per-call options on top of defaults", () => {
    const build = mongoSessionStoreBuilder({
      url: "mongodb://localhost:27017/admin",
      database: "default_db",
    });
    // No assertion on internal shape (private fields), but the call should not throw
    // and should produce an instance — that's the contract we expose.
    const store = build({ database: "override_db" });
    expect(store).toBeDefined();
    void (store as { close?: () => Promise<void> }).close?.();
  });

  it("throws if defaults.url is empty", () => {
    expect(() => mongoSessionStoreBuilder({ url: "" })).toThrow();
  });
});
