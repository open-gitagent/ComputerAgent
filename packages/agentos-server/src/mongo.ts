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

import { MongoClient, type Collection, type Db } from "mongodb";

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
  _id: string;             // agent name
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
  _id: string;             // agent name
  sessionId: string;
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

export async function messagesColl(): Promise<Collection<MessageDoc>> {
  return (await getDb()).collection<MessageDoc>("agent_messages");
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
