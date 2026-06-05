// Unit tests for the BFF refresh-cookie helpers — the signed, server-only
// envelope that POST /auth/refresh trades for a fresh access token.

import { describe, it, expect } from "vitest";
import { signRefresh, verifyRefresh } from "./auth.js";

describe("refresh cookie (signRefresh / verifyRefresh)", () => {
  it("round-trips a refresh token with its expiry", () => {
    const expMs = Date.now() + 30 * 60 * 1000;
    const cookie = signRefresh("rt-abc123", expMs);
    const out = verifyRefresh(cookie);
    expect(out).toEqual({ rt: "rt-abc123", exp: expMs });
  });

  it("rejects an expired cookie", () => {
    const cookie = signRefresh("rt-old", Date.now() - 1000);
    expect(verifyRefresh(cookie)).toBeNull();
  });

  it("rejects a tampered cookie", () => {
    const cookie = signRefresh("rt-abc123", Date.now() + 60_000);
    // Flip a character in the signed payload — HMAC must fail.
    const tampered = cookie.replace(/.$/, (c) => (c === "A" ? "B" : "A"));
    expect(verifyRefresh(tampered)).toBeNull();
  });

  it("rejects a malformed cookie", () => {
    expect(verifyRefresh("not-a-cookie")).toBeNull();
    expect(verifyRefresh("")).toBeNull();
  });
});
