// AgentLogStore — durable audit log of every agent request, in MongoDB.
// One document per handled request (Slack mention, web chat, schedule fire).
// Read by the Logs tab and used to compute per-agent logCount.

import { type Collection } from "mongodb";
import { randomUUID } from "node:crypto";
import { getDb } from "../mongo.js";

export interface AgentLogEntry {
  _id: string;
  ts: Date;
  source: "slack" | "web" | "schedule" | "library";
  bot: string;
  // Parallel to `bot` — the Python ingest path stamps both so per-agent
  // `count()` (keyed on `bot`) and downstream `agentName` consumers both work.
  agentName?: string;
  requester: string;
  channel: string | null;
  threadTs: string | null;
  sessionId: string | null;
  query: string;
  reply: string;
  ok: boolean;
  // Optional run rollups carried by the session_ended event.
  error?: string;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number | null;
}

// `_id` optional: callers that want idempotent retries (the HTTP ingest
// projection) pass a deterministic id; everyone else gets a random one.
export type NewAgentLog = Omit<AgentLogEntry, "_id" | "ts"> & { _id?: string; ts?: Date };

export interface AgentLogFilter {
  bot?: string;
  /** Restrict to this set of bots (group-scoped reads). Ignored if empty. */
  bots?: string[];
  source?: "slack" | "web" | "schedule";
  limit?: number;
  before?: Date;
}

async function coll(): Promise<Collection<AgentLogEntry>> {
  return (await getDb()).collection<AgentLogEntry>("agent_logs");
}

export const agentLogStore = {
  async append(entry: NewAgentLog): Promise<void> {
    const doc: AgentLogEntry = {
      _id: entry._id ?? `log_${randomUUID()}`,
      ts: entry.ts ?? new Date(),
      source: entry.source,
      bot: entry.bot,
      requester: entry.requester,
      channel: entry.channel ?? null,
      threadTs: entry.threadTs ?? null,
      sessionId: entry.sessionId ?? null,
      query: entry.query,
      reply: entry.reply,
      ok: entry.ok,
    };
    // Carry the optional rollup fields only when present so existing rows keep
    // their lean shape and we never write explicit `undefined`s.
    if (entry.agentName !== undefined) doc.agentName = entry.agentName;
    if (entry.error !== undefined) doc.error = entry.error;
    if (entry.durationMs !== undefined) doc.durationMs = entry.durationMs;
    if (entry.inputTokens !== undefined) doc.inputTokens = entry.inputTokens;
    if (entry.outputTokens !== undefined) doc.outputTokens = entry.outputTokens;
    if (entry.costUsd !== undefined) doc.costUsd = entry.costUsd;

    if (entry._id) {
      // Caller-supplied id → idempotent: a retried batch with the same
      // event_id is a no-op instead of a duplicate row.
      await (await coll()).updateOne(
        { _id: entry._id },
        { $setOnInsert: doc },
        { upsert: true },
      );
    } else {
      await (await coll()).insertOne(doc);
    }
  },

  async list(filter: AgentLogFilter = {}): Promise<AgentLogEntry[]> {
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 500);
    const q: Record<string, unknown> = {};
    if (filter.bot) q["bot"] = filter.bot;
    else if (filter.bots) q["bot"] = { $in: filter.bots };
    if (filter.source) q["source"] = filter.source;
    if (filter.before) q["ts"] = { $lt: filter.before };
    return (await coll())
      .find(q)
      .sort({ ts: -1 })
      .limit(limit)
      .toArray();
  },

  async get(id: string): Promise<AgentLogEntry | null> {
    return (await coll()).findOne({ _id: id });
  },

  async count(bot: string): Promise<number> {
    return (await coll()).countDocuments({ bot });
  },

  /** Cascade helper — drop every log for an agent. Returns the count. */
  async deleteByBot(bot: string): Promise<number> {
    const r = await (await coll()).deleteMany({ bot });
    return r.deletedCount ?? 0;
  },

  /** Cascade helper — drop every log tied to one session. Returns the count. */
  async deleteBySession(sessionId: string): Promise<number> {
    const r = await (await coll()).deleteMany({ sessionId });
    return r.deletedCount ?? 0;
  },
};
