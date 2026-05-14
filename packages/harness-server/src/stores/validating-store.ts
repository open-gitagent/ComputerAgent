import type { SessionKey, SessionStore, SessionStoreEntry } from "@computeragent/protocol";

/**
 * Wraps a SessionStore so entries returned from `load()` are validated
 * against the minimum SessionStoreEntry shape — objects with a string `type`
 * field. Malformed entries are silently dropped (with a counter exposed on
 * the wrapper for diagnostics).
 *
 * Used when `createHarnessServer({ validateStoreEntries: true })` is set.
 * Default is OFF: the framework is a pass-through and engine drivers
 * validate. Opt-in is for deployments that want the framework to enforce
 * the contract at the boundary — for example, when the store is shared with
 * external systems that might write incompatible records.
 */
export interface ValidatingStoreStats {
  /** Total number of entries dropped from load() results across all calls. */
  droppedCount: number;
}

export function wrapValidatingStore(inner: SessionStore): SessionStore & {
  readonly stats: ValidatingStoreStats;
} {
  const stats: ValidatingStoreStats = { droppedCount: 0 };

  const wrapper: SessionStore & { readonly stats: ValidatingStoreStats } = {
    stats,
    async load(key: SessionKey): Promise<SessionStoreEntry[] | null> {
      const raw = await inner.load(key);
      if (!raw) return raw;
      const valid: SessionStoreEntry[] = [];
      for (const entry of raw) {
        if (isValidEntry(entry)) {
          valid.push(entry);
        } else {
          stats.droppedCount += 1;
        }
      }
      return valid;
    },
    append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
      return inner.append(key, entries);
    },
  };

  // Forward optional methods if the inner store implements them.
  const innerAny = inner as Record<string, unknown>;
  if (typeof innerAny.listSessions === "function") {
    (wrapper as Record<string, unknown>).listSessions =
      (innerAny.listSessions as (k: string) => unknown).bind(inner);
  }
  if (typeof innerAny.listSessionSummaries === "function") {
    (wrapper as Record<string, unknown>).listSessionSummaries =
      (innerAny.listSessionSummaries as (k: string) => unknown).bind(inner);
  }

  return wrapper;
}

/**
 * Minimum SessionStoreEntry contract:
 *   - object (not null, not array)
 *   - has a `type` field that is a non-empty string
 *
 * Everything else is passthrough — the SDK's SessionStoreEntry type allows
 * arbitrary extra keys via `[k: string]: unknown`. We don't enforce uuid /
 * timestamp shape because they're optional in the contract.
 */
function isValidEntry(value: unknown): value is SessionStoreEntry {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return typeof v.type === "string" && v.type.length > 0;
}
