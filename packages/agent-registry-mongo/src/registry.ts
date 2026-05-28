/**
 * `agent_registry` collection — one document per registered agent.
 *
 * Schema (single shared shape across reads + writes):
 *
 *   {
 *     _id:           string,       // agent name (unique key)
 *     label?:        string,       // pretty name for the dashboard
 *     harness:       string,       // "claude-agent-sdk" | "gitagent" | ...
 *     source:        unknown,      // IdentitySource (git/local/inline) — JSON-safe shape
 *     model?:        string,       // resolved model id (best-effort)
 *     registeredBy?: string,       // free-form: hostname, pod name, "ci", ...
 *     registeredAt:  Date,         // first time we saw this name (created)
 *     updatedAt:     Date,         // last write
 *     lastSeen:      Date,         // most recent ComputerAgent construct
 *   }
 *
 * The dashboard reads this collection; the SDK upserts to it via
 * `MongoTelemetry.onAgentConstructed`. Tests and tooling can also write
 * directly via this class.
 */
import { MongoClient, type Collection, type Db } from "mongodb";

export interface AgentRegistrySpec {
  /** Stable agent name. Used as the doc _id; uniquely identifies the agent. */
  readonly name: string;
  readonly label?: string;
  readonly harness: string;
  readonly source: unknown;
  readonly model?: string;
  readonly registeredBy?: string;
}

export interface AgentRegistryDoc extends AgentRegistrySpec {
  readonly _id: string;
  readonly registeredAt: Date;
  readonly updatedAt: Date;
  readonly lastSeen: Date;
}

export class AgentRegistry {
  private readonly client: MongoClient;
  private readonly dbName: string;
  private readonly collectionName: string;
  private connected = false;
  private connectPromise: Promise<void> | null = null;

  constructor(opts: {
    url: string;
    database: string;
    collection?: string;
    /** Pass an existing MongoClient instead of `url` to share connection pools. */
    client?: MongoClient;
  }) {
    this.client = opts.client ?? new MongoClient(opts.url);
    this.dbName = opts.database;
    this.collectionName = opts.collection ?? "agent_registry";
  }

  private async db(): Promise<Db> {
    if (!this.connected) {
      if (!this.connectPromise) {
        this.connectPromise = this.client.connect().then(() => {
          this.connected = true;
        });
      }
      await this.connectPromise;
    }
    return this.client.db(this.dbName);
  }

  private async coll(): Promise<Collection<AgentRegistryDoc>> {
    return (await this.db()).collection<AgentRegistryDoc>(this.collectionName);
  }

  /**
   * Idempotent upsert. First write sets `registeredAt`; every subsequent
   * write only refreshes `updatedAt`, `lastSeen`, and any changed metadata.
   * Safe to call on every ComputerAgent construct.
   */
  async register(spec: AgentRegistrySpec): Promise<void> {
    const now = new Date();
    const set: Partial<AgentRegistryDoc> = {
      label: spec.label,
      harness: spec.harness,
      source: spec.source,
      model: spec.model,
      registeredBy: spec.registeredBy,
      updatedAt: now,
      lastSeen: now,
    };
    // Strip undefined so MongoDB doesn't store explicit nulls.
    for (const k of Object.keys(set) as (keyof typeof set)[]) {
      if (set[k] === undefined) delete set[k];
    }
    await (
      await this.coll()
    ).updateOne(
      { _id: spec.name },
      {
        $set: set,
        $setOnInsert: { _id: spec.name, registeredAt: now },
      },
      { upsert: true },
    );
  }

  /** Remove one agent from the registry. */
  async unregister(name: string): Promise<void> {
    await (await this.coll()).deleteOne({ _id: name });
  }

  async get(name: string): Promise<AgentRegistryDoc | null> {
    return await (await this.coll()).findOne({ _id: name });
  }

  /** All registered agents, newest `updatedAt` first. */
  async list(): Promise<AgentRegistryDoc[]> {
    return await (
      await this.coll()
    )
      .find({}, { sort: { updatedAt: -1 } })
      .toArray();
  }

  /** Release the underlying MongoClient connection. Idempotent. */
  async close(): Promise<void> {
    if (this.connected) {
      await this.client.close();
      this.connected = false;
    }
  }
}
