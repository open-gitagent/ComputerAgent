import { MongoClient, type Collection, type Db, type MongoClientOptions } from "mongodb";
import type {
  SessionKey,
  SessionStore,
  SessionStoreEntry,
} from "@open-gitagent/protocol";

/**
 * MongoDB-backed SessionStore. One document per session, keyed by sessionId.
 *
 * Document shape:
 *   {
 *     _id: <sessionId>,
 *     projectKey: <string>,
 *     entries: [<SessionStoreEntry>, ...],
 *     updatedAt: <Date>,
 *   }
 *
 * Idempotency by entry.uuid: a duplicate uuid append is skipped. Currently
 * implemented with a load-then-write pattern, which is correct for single-
 * writer flows (the harness server is single-writer per session). Multi-
 * writer correctness requires either an aggregation-pipeline update or a
 * lock; documented limitation.
 *
 * Lifecycle: pass a `mongoUrl` to construct, call `connect()` once before
 * first use (lazy: `append`/`load` will auto-connect on first call), and
 * `close()` when done.
 */
export interface MongoSessionStoreOptions {
  /** Mongo connection string. Required. */
  readonly url: string;
  /** Database name. Default: `computeragent_sessions`. */
  readonly database?: string;
  /** Collection name. Default: `sessions`. */
  readonly collection?: string;
  /** Optional MongoClient options forwarded verbatim. */
  readonly clientOptions?: MongoClientOptions;
}

interface SessionDoc {
  _id: string;
  projectKey: string;
  entries: SessionStoreEntry[];
  updatedAt: Date;
}

export class MongoSessionStore implements SessionStore {
  private readonly client: MongoClient;
  private readonly databaseName: string;
  private readonly collectionName: string;
  private connected = false;
  private connectPromise: Promise<void> | null = null;

  constructor(opts: MongoSessionStoreOptions) {
    if (!opts.url) throw new Error("MongoSessionStore: url is required");
    this.client = new MongoClient(opts.url, opts.clientOptions);
    this.databaseName = opts.database ?? "computeragent_sessions";
    this.collectionName = opts.collection ?? "sessions";
  }

  /** Open the connection. Idempotent; lazy callers don't need to invoke this. */
  async connect(): Promise<void> {
    if (this.connected) return;
    if (!this.connectPromise) {
      this.connectPromise = this.client.connect().then(() => {
        this.connected = true;
      });
    }
    await this.connectPromise;
  }

  /** Close the MongoClient. Safe to call multiple times. */
  async close(): Promise<void> {
    if (!this.connected) return;
    this.connected = false;
    this.connectPromise = null;
    await this.client.close();
  }

  async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const coll = await this.collection();
    const doc = await coll.findOne({ _id: key.sessionId });
    const existing = doc?.entries ?? [];
    const seenUuids = new Set(
      existing.map((e) => e.uuid).filter((u): u is string => typeof u === "string"),
    );
    const fresh = entries.filter((e) => !e.uuid || !seenUuids.has(e.uuid));
    if (fresh.length === 0) return;
    await coll.updateOne(
      { _id: key.sessionId },
      {
        $push: { entries: { $each: fresh } as never },
        $set: { projectKey: key.projectKey, updatedAt: new Date() },
        $setOnInsert: { _id: key.sessionId } as never,
      },
      { upsert: true },
    );
  }

  async load(key: SessionKey): Promise<SessionStoreEntry[] | null> {
    const coll = await this.collection();
    const doc = await coll.findOne({ _id: key.sessionId });
    if (!doc?.entries || doc.entries.length === 0) return null;
    return doc.entries;
  }

  /** Test/admin helper: number of entries stored for a sessionId. */
  async size(sessionId: string): Promise<number> {
    const coll = await this.collection();
    const doc = await coll.findOne({ _id: sessionId });
    return doc?.entries?.length ?? 0;
  }

  /** Diagnostic: list the most-recently-touched sessions. */
  async listSessions(projectKey: string): Promise<{ sessionId: string; mtime: number }[]> {
    const coll = await this.collection();
    const docs = await coll
      .find({ projectKey })
      .sort({ updatedAt: -1 })
      .limit(50)
      .toArray();
    return docs.map((d) => ({ sessionId: d._id, mtime: d.updatedAt.getTime() }));
  }

  private async collection(): Promise<Collection<SessionDoc>> {
    await this.connect();
    const db: Db = this.client.db(this.databaseName);
    return db.collection<SessionDoc>(this.collectionName);
  }
}
