import type { SessionStore, SessionStoreConfig } from "@open-gitagent/protocol";
import { BadRequest } from "../error-mapper.js";
import { MemorySessionStore } from "./memory-store.js";
import { FileSessionStore } from "./file-store.js";

/**
 * Builder for one kind of SessionStore. Mirrors the shape of how engines and
 * identityLoaders are registered: a `Record<kind, builder>` map handed to
 * `createHarnessServer({...})`. Custom backends (Mongo, Redis, S3) plug in by
 * registering their own builder — no fork of the framework required.
 */
export type SessionStoreBuilder = (options: unknown) => SessionStore;
export type SessionStoreRegistry = Readonly<Record<string, SessionStoreBuilder>>;

/**
 * Built-in store kinds. `createHarnessServer` merges any user-supplied
 * builders on top of these, so a user can override `memory`/`file` with a
 * custom implementation or add new kinds.
 */
export const DEFAULT_STORE_BUILDERS: SessionStoreRegistry = {
  memory: () => new MemorySessionStore(),
  file: (options) => new FileSessionStore(options as { root: string }),
};

/**
 * Resolve a wire-side store descriptor to a live SessionStore instance via
 * the registry. Throws `BadRequest("UNKNOWN_STORE", ...)` when the requested
 * kind isn't registered — same wire-error pattern as UNKNOWN_ENGINE /
 * UNKNOWN_LOADER.
 */
export function resolveStore(
  registry: SessionStoreRegistry,
  config: SessionStoreConfig,
): SessionStore {
  const builder = registry[config.kind];
  if (!builder) {
    throw BadRequest("UNKNOWN_STORE", `session store '${config.kind}' is not registered`, {
      available: Object.keys(registry),
    });
  }
  return builder(config.options);
}
