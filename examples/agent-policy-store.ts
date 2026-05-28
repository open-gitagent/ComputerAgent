/**
 * AgentPolicyStore — agent → SRS policy_id binding, in MongoDB
 * (`agent_policy_bindings`).
 *
 * One binding per agent. When set, the runtime fetches that policy from SRS
 * and uses it as a PolicyDecider over every tool call. Detach by passing
 * `null` to setBinding (or DELETE the route).
 *
 * Source of truth for the policy *content* is SRS itself — this collection
 * stores only the {agent, policy_id} link.
 */
import { MongoClient, type Collection } from "mongodb";

export interface AgentPolicyBinding {
  _id: string;          // agent name (the natural key)
  policyId: string;
  updatedAt: Date;
}

export class AgentPolicyStore {
  private readonly client: MongoClient;
  private readonly dbName: string;
  private connected = false;
  private connectPromise: Promise<void> | null = null;

  constructor(url: string, dbName: string) {
    this.client = new MongoClient(url);
    this.dbName = dbName;
  }

  private async coll(): Promise<Collection<AgentPolicyBinding>> {
    if (!this.connected) {
      if (!this.connectPromise) this.connectPromise = this.client.connect().then(() => { this.connected = true; });
      await this.connectPromise;
    }
    return this.client.db(this.dbName).collection<AgentPolicyBinding>("agent_policy_bindings");
  }

  async get(agentName: string): Promise<AgentPolicyBinding | null> {
    return (await this.coll()).findOne({ _id: agentName });
  }

  async set(agentName: string, policyId: string): Promise<AgentPolicyBinding> {
    const doc: AgentPolicyBinding = { _id: agentName, policyId, updatedAt: new Date() };
    await (await this.coll()).updateOne({ _id: agentName }, { $set: doc }, { upsert: true });
    return doc;
  }

  async delete(agentName: string): Promise<void> {
    await (await this.coll()).deleteOne({ _id: agentName });
  }

  async list(): Promise<AgentPolicyBinding[]> {
    return (await this.coll()).find({}).toArray();
  }
}
