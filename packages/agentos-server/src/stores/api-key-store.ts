// API keys in MongoDB (`api_keys`). AgentOS is the sole issuer + store; the
// ComputerAgent server validates a presented key by calling the introspection
// endpoint, which delegates to `apiKeyStore.verify` here.
//
// Storage model (GitHub/Stripe-style, NOT bcrypt/argon2): the key is a 256-bit
// CSPRNG token, so there is nothing to brute-force and no precompute/rainbow
// risk — a single fast hash (SHA-256, or HMAC-SHA256 with an optional server
// pepper) is the correct at-rest scheme and lets us look up by a unique `hash`
// index in O(1). The plaintext is shown exactly once at creation and never
// persisted; only `hash` + non-secret `prefix`/`last4` display fragments live
// in Mongo.

import { type Collection } from "mongodb";
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { getDb } from "../mongo.js";

/** Recognizable prefix (cf. `ghp_`, `sk-ant-`) so leak scanners + humans can
 *  classify the secret on sight. */
export const KEY_PREFIX = "cak_";

export interface ApiKeyDoc {
  _id: string;            // "key_" + uuid slice — surrogate id, NOT the key
  hash: string;           // hex of HMAC-SHA256(pepper,key) | sha256(key) — UNIQUE
  prefix: string;         // display only: first 8 chars of plaintext
  last4: string;          // display only: last 4 chars of plaintext
  label: string;
  group?: string | null;  // display label of the group/role this key acts as
  roleIds: string[];      // roles the key inherits → resolved to permissions via the role map
  scopes: string[];       // DEPRECATED — back-compat for the introspection echo; default ["*"]
  createdBy: string;      // dashboard user who minted it
  createdAt: Date;
  expiresAt?: Date | null;
  lastUsedAt?: Date | null;
  revoked: boolean;
  revokedAt?: Date | null;
}

/** The redacted doc returned across the API boundary — never carries `hash`. */
export type RedactedApiKey = Omit<ApiKeyDoc, "hash">;

export interface CreatedApiKey {
  plaintext: string;      // returned ONCE — never persisted
  doc: RedactedApiKey;
}

export interface IntrospectionResult {
  active: true;
  principal: string;      // the doc _id (stable, non-secret identifier)
  roleIds: string[];      // roles the key acts as → resolved to permissions
  group?: string | null;  // display label of the bound group
  scopes: string[];       // DEPRECATED back-compat
  expiresAt?: Date | null;
}

async function coll(): Promise<Collection<ApiKeyDoc>> {
  return (await getDb()).collection<ApiKeyDoc>("api_keys");
}

/** Hash a plaintext key for storage/lookup. Uses HMAC with a server-side pepper
 *  when AGENTOS_API_KEY_PEPPER is set (so a Mongo-only leak yields useless
 *  hashes), else a plain SHA-256 so dev/test works with no config. The pepper
 *  is a single global value, so the indexed lookup is unaffected. */
function hashKey(plaintext: string): string {
  const pepper = process.env["AGENTOS_API_KEY_PEPPER"];
  return pepper
    ? createHmac("sha256", pepper).update(plaintext).digest("hex")
    : createHash("sha256").update(plaintext).digest("hex");
}

/** Constant-time equality of two hex digests (defense-in-depth; the lookup is
 *  already by unique hash index so there is no per-character oracle). */
function hashEquals(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

function redact(doc: ApiKeyDoc): RedactedApiKey {
  const { hash: _hash, ...rest } = doc;
  return rest;
}

export const apiKeyStore = {
  /** Unique index on `hash`. Idempotent — createIndex is a no-op if it exists. */
  async ensureIndexes(): Promise<void> {
    await (await coll()).createIndex({ hash: 1 }, { unique: true });
  },

  /** Mint a key. Returns the plaintext ONCE plus the redacted doc. */
  async create(input: {
    label: string;
    createdBy: string;
    expiresAt?: Date | null;
    group?: string | null;
    roleIds?: string[];
  }): Promise<CreatedApiKey> {
    const plaintext = KEY_PREFIX + randomBytes(32).toString("base64url");
    const doc: ApiKeyDoc = {
      _id: `key_${randomUUID().slice(0, 12)}`,
      hash: hashKey(plaintext),
      prefix: plaintext.slice(0, 8),
      last4: plaintext.slice(-4),
      label: input.label,
      group: input.group ?? null,
      roleIds: input.roleIds?.length ? [...new Set(input.roleIds)] : [],
      scopes: ["*"], // DEPRECATED — retained so the CAS introspection echo is unchanged
      createdBy: input.createdBy,
      createdAt: new Date(),
      expiresAt: input.expiresAt ?? null,
      lastUsedAt: null,
      revoked: false,
      revokedAt: null,
    };
    await (await coll()).insertOne(doc);
    return { plaintext, doc: redact(doc) };
  },

  /** Validate a presented key. Returns null for any non-active state. */
  async verify(plaintextKey: string): Promise<IntrospectionResult | null> {
    if (typeof plaintextKey !== "string" || !plaintextKey.startsWith(KEY_PREFIX)) {
      return null; // cheap reject of anything that isn't one of our keys
    }
    const h = hashKey(plaintextKey);
    const c = await coll();
    const doc = await c.findOne({ hash: h }); // O(1) unique-indexed lookup
    if (!doc) return null;
    if (!hashEquals(doc.hash, h)) return null; // belt-and-suspenders
    if (doc.revoked) return null;
    if (doc.expiresAt && doc.expiresAt.getTime() <= Date.now()) return null;
    // Best-effort lastUsedAt; never block or fail the verify on this write.
    void c.updateOne({ _id: doc._id }, { $set: { lastUsedAt: new Date() } }).catch(() => {});
    return {
      active: true,
      principal: doc._id,
      roleIds: doc.roleIds ?? [],
      group: doc.group ?? null,
      scopes: doc.scopes ?? ["*"],
      expiresAt: doc.expiresAt ?? null,
    };
  },

  /** List keys, newest first, with `hash` stripped. */
  async list(): Promise<RedactedApiKey[]> {
    const docs = await (await coll()).find({}).sort({ createdAt: -1 }).toArray();
    return docs.map(redact);
  },

  /** Soft-revoke (idempotent). Returns true if a live key was just revoked. */
  async revoke(id: string): Promise<boolean> {
    const r = await (await coll()).updateOne(
      { _id: id, revoked: false },
      { $set: { revoked: true, revokedAt: new Date() } },
    );
    return (r.modifiedCount ?? 0) > 0;
  },
};
