/**
 * `agent_logs` collection — one document per agent run / chat turn.
 *
 * Originally lived in `examples/agent-log-store.ts` (the Slack bot wrote to
 * it directly). Promoted to a real package so the SDK can write to it via
 * the `AgentTelemetry` hook, making library-mode runs visible in AgentOS
 * with no extra plumbing.
 *
 * Schema:
 *
 *   {
 *     _id:           string,          // "log_<uuid>"
 *     ts:            Date,
 *     source:        string,          // "slack" | "web" | "library" | "schedule" | "test" ...
 *     agentName:     string,          // matches agent_registry._id
 *     requester:     string | null,   // Slack user id, "library", null for schedule
 *     channel:       string | null,
 *     threadTs:      string | null,
 *     sessionId:     string | null,
 *     query:         string,          // truncated to QUERY_MAX
 *     reply:         string,          // truncated to REPLY_MAX
 *     ok:            boolean,
 *     error?:        string,
 *     durationMs?:   number,
 *     inputTokens?:  number,
 *     outputTokens?: number,
 *     costUsd?:      number | null,
 *   }
 */
import { MongoClient, type Collection } from "mongodb";
import { randomUUID } from "node:crypto";

export const QUERY_MAX = 8_000;
export const REPLY_MAX = 16_000;

export interface AgentLogEntry {
  _id: string;
  ts: Date;
  source: string;
  agentName: string;
  requester: string | null;
  channel: string | null;
  threadTs: string | null;
  sessionId: string | null;
  query: string;
  reply: string;
  ok: boolean;
  error?: string;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number | null;
}

export type NewAgentLog = Omit<AgentLogEntry, "_id" | "ts"> & { ts?: Date };

export interface AgentLogFilter {
  agentName?: string;
  source?: string;
  ok?: boolean;
  limit?: number;
  before?: Date;
}

function truncate(s: string | undefined, max: number): string {
  if (!s) return "";
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

export class AgentLogStore {
  private readonly client: MongoClient;
  private readonly dbName: string;
  private readonly collectionName: string;
  private connected = false;
  private connectPromise: Promise<void> | null = null;

  constructor(opts: {
    url: string;
    database: string;
    collection?: string;
    client?: MongoClient;
  }) {
    this.client = opts.client ?? new MongoClient(opts.url);
    this.dbName = opts.database;
    this.collectionName = opts.collection ?? "agent_logs";
  }

  private async coll(): Promise<Collection<AgentLogEntry>> {
    if (!this.connected) {
      if (!this.connectPromise) {
        this.connectPromise = this.client.connect().then(() => {
          this.connected = true;
        });
      }
      await this.connectPromise;
    }
    return this.client.db(this.dbName).collection<AgentLogEntry>(this.collectionName);
  }

  /**
   * Append one entry. Best-effort — callers should not let a log failure
   * break the user-facing flow. The MongoTelemetry impl wraps this in
   * `safeFire` already.
   */
  async append(entry: NewAgentLog): Promise<void> {
    const doc: AgentLogEntry = {
      _id: `log_${randomUUID()}`,
      ts: entry.ts ?? new Date(),
      source: entry.source,
      agentName: entry.agentName,
      requester: entry.requester ?? null,
      channel: entry.channel ?? null,
      threadTs: entry.threadTs ?? null,
      sessionId: entry.sessionId ?? null,
      query: truncate(entry.query, QUERY_MAX),
      reply: truncate(entry.reply, REPLY_MAX),
      ok: entry.ok,
      error: entry.error,
      durationMs: entry.durationMs,
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
      costUsd: entry.costUsd ?? null,
    };
    await (await this.coll()).insertOne(doc);
  }

  /** Most-recent entries first. */
  async list(filter: AgentLogFilter = {}): Promise<AgentLogEntry[]> {
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 500);
    const q: Record<string, unknown> = {};
    if (filter.agentName) q.agentName = filter.agentName;
    if (filter.source) q.source = filter.source;
    if (filter.ok !== undefined) q.ok = filter.ok;
    if (filter.before) q.ts = { $lt: filter.before };
    return await (await this.coll()).find(q).sort({ ts: -1 }).limit(limit).toArray();
  }

  /** Number of entries matching the filter. */
  async count(filter: Omit<AgentLogFilter, "limit" | "before"> = {}): Promise<number> {
    const q: Record<string, unknown> = {};
    if (filter.agentName) q.agentName = filter.agentName;
    if (filter.source) q.source = filter.source;
    if (filter.ok !== undefined) q.ok = filter.ok;
    return await (await this.coll()).countDocuments(q);
  }

  /** Release the underlying MongoClient connection. Idempotent. */
  async close(): Promise<void> {
    if (this.connected) {
      await this.client.close();
      this.connected = false;
    }
  }
}
