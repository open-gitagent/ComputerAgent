// Single Mongo connection shared across all routes + the scheduler.
// Collections used by this server:
//   - chat_sessions   (this server owns it: one row per dashboard web chat
//                       session — { _id: sessionId, agent, createdAt,
//                       lastMessageAt }. Warmth is NOT stored here; it's
//                       queried live from the harness sandbox registry.)
//   - sessions        (read-only here — harness owns the writes via its
//                       sessionStore plugin)
//   - agent_registry  (CRUD'd by dashboard + by library-mode SDK telemetry)
//   - chat_pins       (agent → current dashboard chat sessionId)
//   - agent_logs      (via AgentLogStore — request/reply audit)
//   - agent_schedules (via ScheduleStore — cron-style runs)
//   - agent_messages  (written only by the Python SDK's MongoMessageSink;
//                       read-free here, but the cascade delete sweeps it)
//
// NOTE: `slack_threads` is intentionally NOT touched here. It belongs to the
// optional Slack bot (examples/slack-bot.ts, gated behind SLACK_BOTS_ENABLED).
// The dashboard's web chat used to piggyback on it; that coupling was removed
// in favour of the dedicated `chat_sessions` collection above.

import { MongoClient, ObjectId, type Collection, type Db } from "mongodb";
import type { EvalRunDoc, EvalSuiteDoc } from "./eval-types.js";

let _client: MongoClient | null = null;
let _db: Db | null = null;
let _connectPromise: Promise<void> | null = null;

function url(): string {
  const u = process.env["MONGO_URL"];
  if (!u) throw new Error("MONGO_URL not set");
  return u;
}

function dbName(): string {
  return process.env["MONGO_DATABASE"] ?? "computeragent-test";
}

async function ensureConnected(): Promise<Db> {
  if (_db) return _db;
  if (!_connectPromise) {
    _client = new MongoClient(url());
    _connectPromise = _client.connect().then(() => {
      _db = _client!.db(dbName());
    });
  }
  await _connectPromise;
  return _db!;
}

export async function getDb(): Promise<Db> {
  return ensureConnected();
}

export async function pingMongo(): Promise<boolean> {
  try {
    const db = await ensureConnected();
    await db.command({ ping: 1 });
    return true;
  } catch {
    return false;
  }
}

// ── Collection typings ──────────────────────────────────────────────────

export interface ChatSessionDoc {
  _id: string;             // sessionId
  agent: string;           // owning agent name
  createdAt?: Date;
  lastMessageAt?: Date;
}

export interface SessionDoc {
  _id: string;
  projectKey?: string;
  entries?: Array<{ type?: string; text?: string; uuid?: string }>;
  updatedAt?: Date;
  // Fields stamped by the Python ingest projection (library-mode sessions).
  // The harness's own sessionStore writes the projectKey/SDK-entry shape; the
  // reader normalizes both, and these extra fields are simply ignored there.
  createdAt?: Date;
  agentName?: string;
  source?: string;
  model?: string | null;
  // `meta.prompt` persists the opening prompt so session_ended can recover it
  // for the agent_logs `query` (replaces the Python in-process cache).
  meta?: { prompt?: string; model?: string | null; startedAt?: Date };
  endedAt?: Date;
  ok?: boolean;
  durationMs?: number;
  costUsd?: number | null;
}

export interface RegistryDoc {
  _id: ObjectId;           // surrogate key (Mongo-minted)
  name: string;            // the agent's human identifier (unique index)
  label?: string;
  harness?: string;
  source?: unknown;        // string OR IdentitySource shape
  model?: string;
  registeredBy?: string;
  registeredAt?: Date;
  updatedAt?: Date;
  lastSeen?: Date;
}

export interface ChatPinDoc {
  _id: ObjectId;
  agentName: string;       // owning agent name (unique index)
  sessionId: string;
  updatedAt: Date;
}

export interface PolicyBindingDoc {
  _id: ObjectId;
  agentName: string;       // owning agent name (unique index)
  policyId: string;
  updatedAt: Date;
}

export interface MessageDoc {
  _id: string;
  sessionId: string | null;
  agentName: string | null;
  // Written by the ingest projection (one doc per non-rollup event).
  ts?: Date;
  source?: string;
  host?: string | null;
  kind?: string;
  payload?: unknown;
  latencyMs?: number;
}

// ── Accessors ───────────────────────────────────────────────────────────

export async function chatSessionsColl(): Promise<Collection<ChatSessionDoc>> {
  return (await getDb()).collection<ChatSessionDoc>("chat_sessions");
}

export async function sessionsColl(): Promise<Collection<SessionDoc>> {
  return (await getDb()).collection<SessionDoc>("sessions");
}

export async function registryColl(): Promise<Collection<RegistryDoc>> {
  return (await getDb()).collection<RegistryDoc>("agent_registry");
}

export async function chatPinsColl(): Promise<Collection<ChatPinDoc>> {
  return (await getDb()).collection<ChatPinDoc>("chat_pins");
}

export async function agentPoliciesColl(): Promise<Collection<PolicyBindingDoc>> {
  return (await getDb()).collection<PolicyBindingDoc>("agent_policies");
}

export async function messagesColl(): Promise<Collection<MessageDoc>> {
  return (await getDb()).collection<MessageDoc>("agent_messages");
}

export async function evalSuitesColl(): Promise<Collection<EvalSuiteDoc>> {
  return (await getDb()).collection<EvalSuiteDoc>("eval_suites");
}

export async function evalRunsColl(): Promise<Collection<EvalRunDoc>> {
  return (await getDb()).collection<EvalRunDoc>("eval_runs");
}

// ── One-time migration ──────────────────────────────────────────────────

/**
 * Backfill `chat_sessions` from the legacy `slack_threads` rows the dashboard
 * used to write for web chats (`channel:"web"`). Idempotent — re-running only
 * inserts rows that aren't already present. Leaves genuine Slack rows
 * (`channel:"slack"`) untouched; those still belong to the Slack bot.
 * Returns the number of rows backfilled (0 when nothing legacy remains).
 */
export async function migrateLegacyWebSessions(): Promise<number> {
  const db = await getDb();
  const legacy = db.collection<{ sessionId?: string; bot?: string; createdAt?: Date; lastMessageAt?: Date }>("slack_threads");
  const chat = await chatSessionsColl();
  const webRows = await legacy.find({ channel: "web" }).toArray();
  let backfilled = 0;
  for (const row of webRows) {
    const sessionId = row.sessionId;
    if (!sessionId || !row.bot) continue;
    const r = await chat.updateOne(
      { _id: sessionId },
      {
        $setOnInsert: {
          _id: sessionId,
          agent: row.bot,
          createdAt: row.createdAt ?? new Date(),
          lastMessageAt: row.lastMessageAt ?? row.createdAt ?? new Date(),
        },
      },
      { upsert: true },
    );
    if (r.upsertedCount > 0) backfilled++;
  }
  return backfilled;
}

/**
 * Convert legacy `_id == name` rows to surrogate ObjectId `_id` + a name field,
 * for the three collections that used the agent name as their primary key:
 *   agent_registry → name, chat_pins → agentName, agent_policies → agentName.
 *
 * Idempotent: only rows whose `_id` is still a string (the old name) are
 * touched. Each gets a fresh ObjectId `_id`, the old name copied into the name
 * field, all other fields preserved; the old row is deleted. If a migrated row
 * for that name already exists (partial prior run), the legacy row is just
 * dropped. Cross-collection FKs are by name, so nothing else needs rewriting.
 * MUST run before `ensureRegistryIndexes()` so the unique name index isn't
 * created while duplicate legacy rows still exist.
 */
export async function migrateRegistryObjectIds(): Promise<{ registry: number; pins: number; policies: number }> {
  const db = await getDb();
  const convert = async (collName: string, nameField: string): Promise<number> => {
    const coll = db.collection(collName);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const legacy = await coll.find({ _id: { $type: "string" } } as any).toArray();
    let converted = 0;
    for (const doc of legacy) {
      const oldId = doc["_id"] as unknown as string;
      const { _id: _drop, ...rest } = doc;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const already = await coll.findOne({ [nameField]: oldId } as any);
      if (!already) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await coll.insertOne({ ...rest, _id: new ObjectId(), [nameField]: oldId } as any);
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await coll.deleteOne({ _id: oldId } as any);
      converted++;
    }
    return converted;
  };
  const registry = await convert("agent_registry", "name");
  const pins = await convert("chat_pins", "agentName");
  const policies = await convert("agent_policies", "agentName");
  return { registry, pins, policies };
}

/**
 * Ensure the unique name indexes that back id-based addressing. Idempotent —
 * `createIndex` is a no-op when the index already exists.
 */
export async function ensureRegistryIndexes(): Promise<void> {
  const db = await getDb();
  await db.collection("agent_registry").createIndex({ name: 1 }, { unique: true });
  await db.collection("chat_pins").createIndex({ agentName: 1 }, { unique: true });
  await db.collection("agent_policies").createIndex({ agentName: 1 }, { unique: true });
}
