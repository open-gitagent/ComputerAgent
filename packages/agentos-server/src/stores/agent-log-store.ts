// AgentLogStore — durable audit log of every agent request, in MongoDB.
// One document per handled request (Slack mention, web chat, schedule fire).
// Read by the Logs tab and used to compute per-agent logCount.

import { type Collection } from "mongodb";
import { randomUUID } from "node:crypto";
import { getDb } from "../mongo.js";

export interface AgentLogEntry {
  _id: string;
  ts: Date;
  source: "slack" | "web" | "schedule";
  bot: string;
  requester: string;
  channel: string | null;
  threadTs: string | null;
  sessionId: string | null;
  query: string;
  reply: string;
  ok: boolean;
}

export type NewAgentLog = Omit<AgentLogEntry, "_id" | "ts"> & { ts?: Date };

export interface AgentLogFilter {
  bot?: string;
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
      _id: `log_${randomUUID()}`,
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
    await (await coll()).insertOne(doc);
  },

  async list(filter: AgentLogFilter = {}): Promise<AgentLogEntry[]> {
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 500);
    const q: Record<string, unknown> = {};
    if (filter.bot) q["bot"] = filter.bot;
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
};
