// AES-256-GCM "secret box" for encrypting credentials at rest (git PATs).
//
// API keys are HASHED (one-way) — they only ever need to be matched. A git PAT
// is different: the server must hand the *plaintext* back to the SDK so it can
// clone, so the PAT is ENCRYPTED (reversible) rather than hashed.
//
// Key material comes from `AGENTOS_CREDENTIALS_KEY` (base64 of 32 random bytes).
// An optional `AGENTOS_CREDENTIALS_KEY_OLD` lets you ROTATE: both keys can
// decrypt (selected per blob via `kid`), but new writes always use the current
// key, so ciphertext re-wraps lazily on the next update.
//
// Fail-closed: any encrypt/decrypt with no configured key throws — the
// credential store is unusable without it (private-repo auth simply won't work),
// but public-repo loading is unaffected because it never touches this module.

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const IV_BYTES = 12; // standard GCM nonce length
const KEY_BYTES = 32; // AES-256

export interface EncryptedBlob {
  v: 1; // scheme version
  kid: string; // which key encrypted this (for rotation)
  iv: string; // base64
  ct: string; // base64 ciphertext
  tag: string; // base64 GCM auth tag
}

interface KeyEntry {
  kid: string;
  key: Buffer;
}

// Lazily built so a missing key only errors when credentials are actually used,
// not at import time (keeps the server bootable for public-repo-only setups).
let keyring: { current: KeyEntry | null; byKid: Map<string, KeyEntry> } | null = null;

function parseKey(b64: string | undefined): Buffer | null {
  if (!b64) return null;
  let buf: Buffer;
  try {
    buf = Buffer.from(b64, "base64");
  } catch {
    return null;
  }
  return buf.length === KEY_BYTES ? buf : null;
}

/** Stable, non-secret id for a key (so a blob records which key sealed it). */
function kidOf(key: Buffer): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 12);
}

function loadKeyring(): { current: KeyEntry | null; byKid: Map<string, KeyEntry> } {
  if (keyring) return keyring;
  const byKid = new Map<string, KeyEntry>();
  const current = parseKey(process.env["AGENTOS_CREDENTIALS_KEY"]);
  const old = parseKey(process.env["AGENTOS_CREDENTIALS_KEY_OLD"]);
  let cur: KeyEntry | null = null;
  if (current) {
    cur = { kid: kidOf(current), key: current };
    byKid.set(cur.kid, cur);
  }
  if (old) {
    const e = { kid: kidOf(old), key: old };
    if (!byKid.has(e.kid)) byKid.set(e.kid, e);
  }
  keyring = { current: cur, byKid };
  return keyring;
}

/** Test/boot hook: re-read env (e.g. after setting keys in a test). */
export function resetKeyringForTests(): void {
  keyring = null;
}

/** True when at least the current key is configured. */
export function credentialsKeyConfigured(): boolean {
  return loadKeyring().current !== null;
}

function requireCurrentKey(): KeyEntry {
  const { current } = loadKeyring();
  if (!current) {
    throw new Error(
      "AGENTOS_CREDENTIALS_KEY is not set (or not 32 bytes base64) — cannot encrypt credentials",
    );
  }
  return current;
}

export function encryptSecret(plaintext: string): EncryptedBlob {
  const { kid, key } = requireCurrentKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { v: 1, kid, iv: iv.toString("base64"), ct: ct.toString("base64"), tag: tag.toString("base64") };
}

export function decryptSecret(blob: EncryptedBlob): string {
  const { byKid } = loadKeyring();
  const entry = byKid.get(blob.kid);
  if (!entry) {
    throw new Error(`no credentials key for kid=${blob.kid} (rotate via AGENTOS_CREDENTIALS_KEY_OLD?)`);
  }
  const decipher = createDecipheriv("aes-256-gcm", entry.key, Buffer.from(blob.iv, "base64"));
  decipher.setAuthTag(Buffer.from(blob.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(blob.ct, "base64")), decipher.final()]).toString("utf8");
}

/** True when a blob was sealed with a non-current key — caller may re-wrap. */
export function needsRewrap(blob: EncryptedBlob): boolean {
  const { current } = loadKeyring();
  return !!current && blob.kid !== current.kid;
}
