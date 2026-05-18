import type { TaskStore } from "@computeragent/protocol";
import { MongoTaskStore, type MongoTaskStoreOptions } from "./mongo-store.js";

/**
 * One-call builder for the harness server's `taskStores` registry. Wraps
 * `MongoTaskStore` so users can register the Mongo backend in a single line:
 *
 *   new ComputerAgentServer({
 *     ...,
 *     taskStores: { mongo: mongoTaskStoreBuilder({ url: process.env.MONGO_URL! }) },
 *   });
 *
 * The returned builder honors per-call `options` from the wire-side
 * `TaskStoreConfig.options` — useful when different tasks need different
 * databases / collections under the same Mongo cluster:
 *
 *   client side:  taskStore: { kind: "mongo", options: { database: "tenant_a" } }
 *
 * Per-call options merge on top of the defaults passed to this helper.
 */
export function mongoTaskStoreBuilder(
  defaults: MongoTaskStoreOptions,
): (options?: unknown) => TaskStore {
  if (!defaults.url) throw new Error("mongoTaskStoreBuilder: defaults.url is required");
  return (options) => {
    const overrides = (options ?? {}) as Partial<MongoTaskStoreOptions>;
    return new MongoTaskStore({ ...defaults, ...overrides });
  };
}
