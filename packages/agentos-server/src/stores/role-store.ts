// Roles in MongoDB (`roles`). A role maps a Keycloak role NAME to a set of
// permission keys. AgentOS owns this map (editable in Settings→Roles); Okta +
// Keycloak only decide which role NAMES a user has. The same map resolves
// permissions for API keys (which are stamped with `roleIds`).
//
// `permissionsFor` is read on every gated request, so the full map is cached
// in-process (short TTL — covers multi-instance staleness — plus an explicit
// clear on every local write for instant propagation).

import { type Collection } from "mongodb";
import { getDb } from "../mongo.js";
import { WILDCARD, isKnownPermission } from "../auth/permissions.js";

export interface RoleDoc {
  _id: string; // role name == Keycloak role name
  description: string;
  permissions: string[]; // permission keys, or ["*"]
  builtin: boolean; // seeded defaults — cannot be deleted
  updatedAt: Date;
}

/** Seeded on boot. Role names MUST match what Keycloak emits in the token. */
const DEFAULT_ROLES: Array<Omit<RoleDoc, "updatedAt">> = [
  { _id: "agentos-admin", description: "Full access to everything.", permissions: [WILDCARD], builtin: true },
  {
    _id: "agentos-editor",
    description: "Manage and run agents, schedules, and evals (no deletes, keys, or roles).",
    permissions: [
      "agents:read", "agents:write", "agents:run",
      "sessions:read",
      "schedules:read", "schedules:write",
      "logs:read", "logs:write",
      "completion:run",
      "policies:read",
      "evals:read", "evals:write",
      "obs:read",
      "keys:read",
      "git-credentials:read", "git-credentials:manage",
    ],
    builtin: true,
  },
  {
    _id: "agentos-viewer",
    description: "Read-only access.",
    permissions: ["agents:read", "sessions:read", "schedules:read", "logs:read", "policies:read", "evals:read", "obs:read"],
    builtin: true,
  },
];

async function coll(): Promise<Collection<RoleDoc>> {
  return (await getDb()).collection<RoleDoc>("roles");
}

const TTL_MS = 10_000;
let cache: { at: number; map: Map<string, string[]> } | null = null;

async function allRoles(): Promise<Map<string, string[]>> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.map;
  const docs = await (await coll()).find({}).toArray();
  const map = new Map<string, string[]>(docs.map((d) => [d._id, d.permissions]));
  cache = { at: Date.now(), map };
  return map;
}

function invalidate(): void {
  cache = null;
}

export const roleStore = {
  /** Idempotent: insert builtin roles if missing; never clobber edited ones. */
  async seedDefaults(): Promise<void> {
    const c = await coll();
    for (const r of DEFAULT_ROLES) {
      await c.updateOne({ _id: r._id }, { $setOnInsert: { ...r, updatedAt: new Date() } }, { upsert: true });
    }
    invalidate();
  },

  /** Union of permission keys across the given role names (cached). */
  async permissionsFor(roleNames: string[]): Promise<string[]> {
    const map = await allRoles();
    const out = new Set<string>();
    for (const name of roleNames) for (const p of map.get(name) ?? []) out.add(p);
    return [...out];
  },

  async list(): Promise<RoleDoc[]> {
    return (await coll()).find({}).sort({ _id: 1 }).toArray();
  },

  async get(id: string): Promise<RoleDoc | null> {
    return (await coll()).findOne({ _id: id });
  },

  /** Create a custom role. Throws on bad permission keys / duplicate name. */
  async create(input: { name: string; description?: string; permissions: string[] }): Promise<RoleDoc> {
    const bad = input.permissions.filter((p) => !isKnownPermission(p));
    if (bad.length) throw new RoleValidationError(`unknown permissions: ${bad.join(", ")}`);
    const doc: RoleDoc = {
      _id: input.name,
      description: input.description ?? "",
      permissions: [...new Set(input.permissions)],
      builtin: false,
      updatedAt: new Date(),
    };
    const c = await coll();
    if (await c.findOne({ _id: doc._id })) throw new RoleValidationError(`role already exists: ${doc._id}`);
    await c.insertOne(doc);
    invalidate();
    return doc;
  },

  /** Update a role's description/permissions. Builtin perms editable; name fixed. */
  async update(id: string, fields: { description?: string; permissions?: string[] }): Promise<RoleDoc | null> {
    const set: Partial<RoleDoc> = { updatedAt: new Date() };
    if (typeof fields.description === "string") set.description = fields.description;
    if (fields.permissions) {
      const bad = fields.permissions.filter((p) => !isKnownPermission(p));
      if (bad.length) throw new RoleValidationError(`unknown permissions: ${bad.join(", ")}`);
      set.permissions = [...new Set(fields.permissions)];
    }
    const c = await coll();
    const r = await c.updateOne({ _id: id }, { $set: set });
    invalidate();
    if (r.matchedCount === 0) return null;
    return c.findOne({ _id: id });
  },

  /** Delete a custom role. Returns "not_found" | "builtin" | "deleted". */
  async remove(id: string): Promise<"not_found" | "builtin" | "deleted"> {
    const c = await coll();
    const doc = await c.findOne({ _id: id });
    if (!doc) return "not_found";
    if (doc.builtin) return "builtin";
    await c.deleteOne({ _id: id });
    invalidate();
    return "deleted";
  },
};

export class RoleValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoleValidationError";
  }
}
