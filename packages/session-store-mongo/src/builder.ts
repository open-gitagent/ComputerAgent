import type { SessionStore } from "@computeragent/protocol";
import { MongoSessionStore, type MongoSessionStoreOptions } from "./mongo-store.js";

/**
 * One-call builder for the harness server's `sessionStores` registry.
 * Wraps `MongoSessionStore` so users can register the Mongo backend in a
 * single line:
 *
 *   createHarnessServer({
 *     ...,
 *     sessionStores: { mongo: mongoSessionStoreBuilder({ url: process.env.MONGO_URL! }) },
 *   });
 *
 * The returned builder honors per-call `options` from the wire-side
 * `SessionStoreConfig.options` — useful when different sessions need
 * different databases or collections under the same Mongo cluster:
 *
 *   client side:  sessionStore: { kind: "mongo", options: { database: "tenant_a" } }
 *
 * Per-call options merge on top of the defaults passed to this helper.
 */
export function mongoSessionStoreBuilder(
  defaults: MongoSessionStoreOptions,
): (options?: unknown) => SessionStore {
  if (!defaults.url) throw new Error("mongoSessionStoreBuilder: defaults.url is required");
  return (options) => {
    const overrides = (options ?? {}) as Partial<MongoSessionStoreOptions>;
    return new MongoSessionStore({ ...defaults, ...overrides });
  };
}
