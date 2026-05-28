import { MongoClient, type Collection, type Db, type MongoClientOptions } from "mongodb";
import type {
  PersistedEvent,
  TaskDoc,
  TaskFilter,
  TaskInit,
  TaskStatus,
  TaskStore,
  TaskSummary,
} from "@open-gitagent/protocol";

/**
 * MongoDB-backed TaskStore. One document per task, keyed by `taskId`.
 *
 * Document shape:
 *   {
 *     _id:           <taskId>,
 *     sessionId:     <string>,
 *     status:        <TaskStatus>,
 *     config:        <Record<string, unknown>>,      // request body, secrets redacted
 *     events:        [<PersistedEvent>, ...],        // append-only log
 *     usage:         <TaskUsage>,
 *     startedAt:     <Date>,
 *     endedAt:       <Date | undefined>,
 *     lastEventAt:   <Date>,
 *     error:         <string | undefined>,
 *     artifactRefs:  [...],
 *   }
 *
 * Mirrors `MongoSessionStore` deliberately — same lazy-connect lifecycle,
 * same single-writer assumption (the harness server's task runner is the
 * single writer per taskId). Idempotent on duplicate event.id (load + skip
 * pattern, sufficient for the single-writer flow).
 */
export interface MongoTaskStoreOptions {
  /** Mongo connection string. Required. */
  readonly url: string;
  /** Database name. Default: `computeragent_tasks`. */
  readonly database?: string;
  /** Collection name. Default: `tasks`. */
  readonly collection?: string;
  /** Optional MongoClient options forwarded verbatim. */
  readonly clientOptions?: MongoClientOptions;
}

interface MongoTaskDoc {
  _id: string;                  // taskId
  sessionId: string;
  status: TaskStatus;
  config?: Record<string, unknown>;
  events: PersistedEvent[];
  usage?: TaskDoc["usage"];
  startedAt: Date;
  endedAt?: Date;
  lastEventAt: Date;
  error?: string;
  artifactRefs?: TaskDoc["artifactRefs"];
}

export class MongoTaskStore implements TaskStore {
  private readonly client: MongoClient;
  private readonly databaseName: string;
  private readonly collectionName: string;
  private connected = false;
  private connectPromise: Promise<void> | null = null;

  constructor(opts: MongoTaskStoreOptions) {
    if (!opts.url) throw new Error("MongoTaskStore: url is required");
    this.client = new MongoClient(opts.url, opts.clientOptions);
    this.databaseName = opts.database ?? "computeragent_tasks";
    this.collectionName = opts.collection ?? "tasks";
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

  async createTask(taskId: string, init: TaskInit): Promise<void> {
    const coll = await this.collection();
    const now = new Date();
    const doc: MongoTaskDoc = {
      _id: taskId,
      sessionId: init.sessionId,
      status: init.status ?? "queued",
      events: [],
      startedAt: now,
      lastEventAt: now,
      ...(init.config ? { config: init.config } : {}),
    };
    // Upsert so retries with the same taskId don't error — the runner can
    // safely call createTask on resume after a crash.
    await coll.updateOne(
      { _id: taskId },
      { $setOnInsert: doc as never },
      { upsert: true },
    );
  }

  async appendEvent(taskId: string, ev: PersistedEvent): Promise<void> {
    const coll = await this.collection();
    // Dedupe on event.id (single-writer pattern; safe load-then-write).
    const existing = await coll.findOne(
      { _id: taskId, "events.id": ev.id },
      { projection: { _id: 1 } },
    );
    if (existing) return; // already persisted
    await coll.updateOne(
      { _id: taskId },
      {
        $push: { events: ev } as never,
        $set: { lastEventAt: ev.ts },
      },
    );
  }

  async updateStatus(
    taskId: string,
    status: TaskStatus,
    fields?: Partial<Omit<TaskDoc, "taskId" | "status" | "events">>,
  ): Promise<void> {
    const coll = await this.collection();
    const $set: Record<string, unknown> = { status };
    if (fields) {
      for (const [k, v] of Object.entries(fields)) {
        if (v !== undefined) $set[k] = v;
      }
    }
    await coll.updateOne({ _id: taskId }, { $set });
  }

  async load(taskId: string): Promise<TaskDoc | null> {
    const coll = await this.collection();
    const doc = await coll.findOne({ _id: taskId });
    if (!doc) return null;
    return toTaskDoc(doc);
  }

  async loadEventsSince(
    taskId: string,
    since: number,
  ): Promise<readonly PersistedEvent[]> {
    const coll = await this.collection();
    // Server-side filter via $elemMatch projection. For very long event
    // logs we could move to a separate `task_events` collection with
    // (taskId, id) compound index, but for v1 this is fine — typical
    // tasks have < 1000 events.
    const doc = await coll.findOne(
      { _id: taskId },
      { projection: { events: { $filter: { input: "$events", as: "e", cond: { $gt: ["$$e.id", since] } } } } as never },
    );
    return (doc?.events ?? []) as PersistedEvent[];
  }

  async listTasks(filter?: TaskFilter): Promise<readonly TaskSummary[]> {
    const coll = await this.collection();
    const q: Record<string, unknown> = {};
    if (filter?.status) {
      q.status = Array.isArray(filter.status) ? { $in: filter.status } : filter.status;
    }
    if (filter?.sessionId) q.sessionId = filter.sessionId;
    if (filter?.since) q.startedAt = { $gte: filter.since };
    const limit = Math.max(1, Math.min(filter?.limit ?? 50, 500));
    const docs = await coll
      .find(q, { projection: { events: 0 } })
      .sort({ startedAt: -1 })
      .limit(limit)
      .toArray();
    return docs.map((d) => toTaskSummary(d as MongoTaskDoc));
  }

  async delete(taskId: string): Promise<void> {
    const coll = await this.collection();
    await coll.deleteOne({ _id: taskId });
  }

  private async collection(): Promise<Collection<MongoTaskDoc>> {
    await this.connect();
    const db: Db = this.client.db(this.databaseName);
    return db.collection<MongoTaskDoc>(this.collectionName);
  }
}

function toTaskDoc(d: MongoTaskDoc): TaskDoc {
  return {
    taskId: d._id,
    sessionId: d.sessionId,
    status: d.status,
    events: d.events ?? [],
    startedAt: d.startedAt,
    lastEventAt: d.lastEventAt,
    ...(d.config ? { config: d.config } : {}),
    ...(d.usage ? { usage: d.usage } : {}),
    ...(d.endedAt ? { endedAt: d.endedAt } : {}),
    ...(d.error ? { error: d.error } : {}),
    ...(d.artifactRefs ? { artifactRefs: d.artifactRefs } : {}),
  };
}

function toTaskSummary(d: MongoTaskDoc): TaskSummary {
  const full = toTaskDoc(d);
  const { events: _events, ...rest } = full;
  return rest;
}
