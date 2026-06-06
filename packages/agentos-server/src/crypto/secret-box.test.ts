// Unit tests for the AES-256-GCM secret box: round-trip, tamper detection, and
// key rotation via `kid` (decrypt-old / re-wrap-on-write).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  encryptSecret,
  decryptSecret,
  needsRewrap,
  credentialsKeyConfigured,
  resetKeyringForTests,
} from "./secret-box.js";

const KEY_A = Buffer.alloc(32, 1).toString("base64");
const KEY_B = Buffer.alloc(32, 2).toString("base64");

beforeEach(() => {
  delete process.env["AGENTOS_CREDENTIALS_KEY"];
  delete process.env["AGENTOS_CREDENTIALS_KEY_OLD"];
  resetKeyringForTests();
});
afterEach(() => {
  delete process.env["AGENTOS_CREDENTIALS_KEY"];
  delete process.env["AGENTOS_CREDENTIALS_KEY_OLD"];
  resetKeyringForTests();
});

describe("secret-box", () => {
  it("round-trips a secret and never stores plaintext in the blob", () => {
    process.env["AGENTOS_CREDENTIALS_KEY"] = KEY_A;
    resetKeyringForTests();
    const blob = encryptSecret("ghp_supersecret");
    expect(blob.v).toBe(1);
    expect(JSON.stringify(blob)).not.toContain("ghp_supersecret");
    expect(decryptSecret(blob)).toBe("ghp_supersecret");
  });

  it("fails closed when no key is configured", () => {
    expect(credentialsKeyConfigured()).toBe(false);
    expect(() => encryptSecret("x")).toThrow(/AGENTOS_CREDENTIALS_KEY/);
  });

  it("rejects a tampered ciphertext / auth tag", () => {
    process.env["AGENTOS_CREDENTIALS_KEY"] = KEY_A;
    resetKeyringForTests();
    const blob = encryptSecret("token");
    const tampered = { ...blob, ct: Buffer.from("garbage").toString("base64") };
    expect(() => decryptSecret(tampered)).toThrow();
  });

  it("decrypts an old-key blob after rotation and flags it for re-wrap", () => {
    process.env["AGENTOS_CREDENTIALS_KEY"] = KEY_A;
    resetKeyringForTests();
    const oldBlob = encryptSecret("rotate-me");

    // Rotate: B is current, A becomes the old key.
    process.env["AGENTOS_CREDENTIALS_KEY"] = KEY_B;
    process.env["AGENTOS_CREDENTIALS_KEY_OLD"] = KEY_A;
    resetKeyringForTests();

    expect(decryptSecret(oldBlob)).toBe("rotate-me"); // old key still decrypts
    expect(needsRewrap(oldBlob)).toBe(true); // sealed with non-current key
    expect(needsRewrap(encryptSecret("fresh"))).toBe(false); // new writes use current
  });

  it("cannot decrypt once the sealing key is gone entirely", () => {
    process.env["AGENTOS_CREDENTIALS_KEY"] = KEY_A;
    resetKeyringForTests();
    const blob = encryptSecret("orphan");
    process.env["AGENTOS_CREDENTIALS_KEY"] = KEY_B; // A no longer present anywhere
    delete process.env["AGENTOS_CREDENTIALS_KEY_OLD"];
    resetKeyringForTests();
    expect(() => decryptSecret(blob)).toThrow(/no credentials key/);
  });
});
