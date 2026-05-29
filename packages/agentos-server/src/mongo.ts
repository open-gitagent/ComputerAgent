// Single Mongo connection shared across all routes + the scheduler.
// Collections used by this server:
//   - slack_threads   (Slack bots write rows; we also write a synthetic
//                       channel="web" row per dashboard chat session)
//   - sessions        (read-only here — harness owns the writes via its
//                       sessionStore plugin)
//   - agent_registry  (CRUD'd by dashboard + by library-mode SDK telemetry)
//   - chat_pins       (agent → current dashboard chat sessionId)
//   - agent_logs      (via AgentLogStore — request/reply audit)
//   - agent_schedules (via ScheduleStore — cron-style runs)

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

export interface ThreadDoc {
  _id: string;
  bot: string;
  channel: string;
  threadTs: string;
  sessionId: string;
  sandboxId: string | null;
  snapshotId: string | null;
  createdAt?: Date;
  lastMessageAt?: Date;
}

export interface SessionDoc {
  _id: string;
  projectKey?: string;
  entries?: Array<{ type?: string; text?: string; uuid?: string }>;
  updatedAt?: Date;
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

// ── Accessors ───────────────────────────────────────────────────────────

export async function threadsColl(): Promise<Collection<ThreadDoc>> {
  return (await getDb()).collection<ThreadDoc>("slack_threads");
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
