/**
 * AgentLogStore — durable audit log of every agent request, in MongoDB.
 *
 * Each handled request (Slack mention or AgentOS web chat) appends one document
 * to the `agent_logs` collection: who asked, what they asked, and the agent's
 * reply. The Slack bot already DMs the owner this info (ephemeral); persisting
 * it here makes it queryable by the AgentOS control panel.
 */
import { MongoClient, type Collection } from "mongodb";
import { randomUUID } from "node:crypto";

export interface AgentLogEntry {
  _id: string;
  ts: Date;
  source: "slack" | "web";
  bot: string;
  requester: string;          // Slack user id, or "web" for console chats
  channel: string | null;     // Slack channel id (null for web)
  threadTs: string | null;    // Slack thread root ts (null for web)
  sessionId: string | null;   // pinned ComputerAgent session id
  query: string;
  reply: string;
  ok: boolean;                // false when the turn errored
}

export type NewAgentLog = Omit<AgentLogEntry, "_id" | "ts"> & { ts?: Date };

export interface AgentLogFilter {
  bot?: string;
  source?: "slack" | "web";
  limit?: number;             // default 50, max 500
  before?: Date;              // for pagination — return entries older than this
}

export class AgentLogStore {
  private readonly client: MongoClient;
  private readonly dbName: string;
  private connected = false;
  private connectPromise: Promise<void> | null = null;

  constructor(url: string, dbName: string) {
    this.client = new MongoClient(url);
    this.dbName = dbName;
  }

  private async coll(): Promise<Collection<AgentLogEntry>> {
    if (!this.connected) {
      if (!this.connectPromise) {
        this.connectPromise = this.client.connect().then(() => { this.connected = true; });
      }
      await this.connectPromise;
    }
    return this.client.db(this.dbName).collection<AgentLogEntry>("agent_logs");
  }

  /** Append one log entry. Best-effort — callers should not let a log failure
   * break the user-facing flow. */
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
    await (await this.coll()).insertOne(doc);
  }

  /** Recent entries, newest first. */
  async list(filter: AgentLogFilter = {}): Promise<AgentLogEntry[]> {
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 500);
    const q: Record<string, unknown> = {};
    if (filter.bot) q.bot = filter.bot;
    if (filter.source) q.source = filter.source;
    if (filter.before) q.ts = { $lt: filter.before };
    return (await this.coll())
      .find(q)
      .sort({ ts: -1 })
      .limit(limit)
      .toArray();
  }

  async get(id: string): Promise<AgentLogEntry | null> {
    return (await this.coll()).findOne({ _id: id });
  }

  /**
   * Successful entries for a bot newer than `since`, oldest-first — the input
   * for the knowledge distiller's daily batch. Only `ok` turns are returned
   * (errored turns carry no learnable content). `max` caps the batch size.
   */
  async listSince(bot: string, since: Date, max = 5000): Promise<AgentLogEntry[]> {
    return (await this.coll())
      .find({ bot, ok: true, ts: { $gt: since } })
      .sort({ ts: 1 })
      .limit(Math.min(Math.max(max, 1), 20000))
      .toArray();
  }

  /** Count entries for an agent (used for the agents-list stats). */
  async count(bot: string): Promise<number> {
    return (await this.coll()).countDocuments({ bot });
  }

  /** Close the underlying Mongo connection (for one-shot CLIs). */
  async close(): Promise<void> {
    if (this.connected) await this.client.close();
  }
}
