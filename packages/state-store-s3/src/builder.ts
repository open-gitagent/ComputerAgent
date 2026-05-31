import type { StateStore } from "@open-gitagent/protocol";
import { S3StateStore, type S3StateStoreOptions } from "./s3-store.js";

/**
 * One-call builder for the harness server's `stateStores` registry. Mirrors
 * `mongoTaskStoreBuilder` / `mongoSessionStoreBuilder` — defaults supplied
 * at registration time get merged with per-call options from the wire.
 *
 *   new ComputerAgentServer({
 *     ...,
 *     stateStores: { s3: s3StateStoreBuilder({ bucket: process.env.S3_BUCKET! }) },
 *   });
 *
 * Per-request options merge ON TOP of the defaults — useful when different
 * snapshots want different prefixes under the same bucket:
 *
 *   client body: stateStore: { kind: "s3", options: { prefix: "tenant-a/" } }
 */
export function s3StateStoreBuilder(
  defaults: S3StateStoreOptions,
): (options?: unknown) => StateStore {
  if (!defaults.bucket) throw new Error("s3StateStoreBuilder: defaults.bucket is required");
  return (options) => {
    const overrides = (options ?? {}) as Partial<S3StateStoreOptions>;
    return new S3StateStore({ ...defaults, ...overrides });
  };
}
