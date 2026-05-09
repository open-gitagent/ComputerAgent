import { describe, expect, it } from "vitest";
import { IdentitySource } from "./identity-source.js";

describe("IdentitySource", () => {
  it("accepts a git source", () => {
    const ok = IdentitySource.safeParse({ type: "git", url: "github.com/x/y" });
    expect(ok.success).toBe(true);
  });

  it("accepts a local source", () => {
    const ok = IdentitySource.safeParse({ type: "local", path: "/abs/path" });
    expect(ok.success).toBe(true);
  });

  it("accepts an inline source with manifest only", () => {
    const ok = IdentitySource.safeParse({ type: "inline", manifest: { name: "x" } });
    expect(ok.success).toBe(true);
  });

  it("rejects unknown discriminator", () => {
    const bad = IdentitySource.safeParse({ type: "ftp", url: "..." });
    expect(bad.success).toBe(false);
  });

  it("rejects empty git url", () => {
    const bad = IdentitySource.safeParse({ type: "git", url: "" });
    expect(bad.success).toBe(false);
  });

  it("rejects missing required fields", () => {
    const bad = IdentitySource.safeParse({ type: "local" });
    expect(bad.success).toBe(false);
  });
});
