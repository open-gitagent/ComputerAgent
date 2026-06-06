// Git credentials (PATs) in MongoDB (`git_credentials`). A credential is owned
// by a GROUP (team) and scoped to one HOST — exactly one PAT per (ownerGroup,
// host). The Python SDK fetches it (via the cak_-key resolve endpoint) to clone
// private GAP repos.
//
// Unlike API keys, the secret is reversible: the PAT is AES-256-GCM encrypted at
// rest (see crypto/secret-box) and decrypted only on the resolve path, after
// RBAC + group-ownership checks. The plaintext is NEVER returned by list/CRUD.

import { type Collection } from "mongodb";
import { randomUUID } from "node:crypto";
import { getDb } from "../mongo.js";
import { encryptSecret, decryptSecret, type EncryptedBlob } from "../crypto/secret-box.js";

export interface GitCredentialDoc {
  _id: string; // "gcr_" + uuid slice
  host: string; // normalized, lowercased — e.g. "github.com"
  ownerGroup: string; // TENANCY — required; a PAT is always group-owned
  ownerUser: string; // creator principal id (mutate/delete)
  label: string;
  secret: EncryptedBlob; // AES-256-GCM — NEVER crosses an API boundary
  username?: string | null; // git auth username (default "x-access-token")
  last4: string; // display only
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  rotatedAt?: Date | null;
}

/** Redacted doc returned across the API boundary — never carries `secret`. */
export type RedactedGitCredential = Omit<GitCredentialDoc, "secret"> & { hasSecret: true };

async function coll(): Promise<Collection<GitCredentialDoc>> {
  return (await getDb()).collection<GitCredentialDoc>("git_credentials");
}

/** Normalize any repo URL or host string to a bare lowercased host.
 *  `https://github.com/o/r`, `github.com/o/r`, `git@github.com:o/r`,
 *  `ssh://git@github.com/o/r`, `github.com:443` → `github.com`. */
export function normalizeGitHost(input: string): string {
  let s = (input ?? "").trim();
  if (!s) return "";
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, ""); // strip scheme://
  s = s.replace(/^[^@]+@/, ""); // strip user@ (incl. git@)
  s = s.split(/[/:]/)[0] ?? s; // host ends at first / or : (path or port)
  return s.toLowerCase();
}

function redact(doc: GitCredentialDoc): RedactedGitCredential {
  const { secret: _secret, ...rest } = doc;
  return { ...rest, hasSecret: true };
}

export const gitCredentialStore = {
  /** Unique (ownerGroup, host) — one PAT per group per host. Idempotent. */
  async ensureIndexes(): Promise<void> {
    const c = await coll();
    await c.createIndex({ ownerGroup: 1, host: 1 }, { unique: true });
    await c.createIndex({ ownerUser: 1 });
  },

  /** Create or rotate the (ownerGroup, host) credential. Re-using the same pair
   *  re-encrypts the new PAT under the same `_id` and stamps `rotatedAt`. */
  async upsert(input: {
    host: string;
    ownerGroup: string;
    ownerUser: string;
    label: string;
    plaintextToken: string;
    username?: string | null;
    createdBy: string;
  }): Promise<RedactedGitCredential> {
    const c = await coll();
    const host = normalizeGitHost(input.host);
    const now = new Date();
    const secret = encryptSecret(input.plaintextToken);
    const last4 = input.plaintextToken.slice(-4);
    const existing = await c.findOne({ ownerGroup: input.ownerGroup, host });
    await c.updateOne(
      { ownerGroup: input.ownerGroup, host },
      {
        $set: {
          label: input.label,
          secret,
          last4,
          username: input.username ?? null,
          ownerUser: input.ownerUser,
          updatedAt: now,
          ...(existing ? { rotatedAt: now } : {}),
        },
        $setOnInsert: {
          _id: `gcr_${randomUUID().slice(0, 12)}`,
          host,
          ownerGroup: input.ownerGroup,
          createdBy: input.createdBy,
          createdAt: now,
        },
      },
      { upsert: true },
    );
    const doc = await c.findOne({ ownerGroup: input.ownerGroup, host });
    return redact(doc!);
  },

  /** All credentials (redacted), newest first. Caller applies ownership filter. */
  async list(): Promise<RedactedGitCredential[]> {
    const docs = await (await coll()).find({}).sort({ updatedAt: -1 }).toArray();
    return docs.map(redact);
  },

  async get(id: string): Promise<RedactedGitCredential | null> {
    const doc = await (await coll()).findOne({ _id: id });
    return doc ? redact(doc) : null;
  },

  /** The ONLY decrypt path: return the plaintext PAT for a (group, host) match.
   *  `ownerGroups` is the caller's groups — a credential is returned only when
   *  its `ownerGroup` is one of them. */
  async resolve(input: {
    ownerGroups: string[];
    host: string;
  }): Promise<{ doc: RedactedGitCredential; token: string } | null> {
    const host = normalizeGitHost(input.host);
    if (!host || input.ownerGroups.length === 0) return null;
    const doc = await (await coll()).findOne({ host, ownerGroup: { $in: input.ownerGroups } });
    if (!doc) return null;
    return { doc: redact(doc), token: decryptSecret(doc.secret) };
  },

  async remove(id: string): Promise<boolean> {
    const r = await (await coll()).deleteOne({ _id: id });
    return (r.deletedCount ?? 0) > 0;
  },
};
