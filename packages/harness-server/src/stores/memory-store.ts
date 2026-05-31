import type {
  SessionKey,
  SessionStore,
  SessionStoreEntry,
} from "@open-gitagent/protocol";

/**
 * In-process SessionStore. Holds appended entries in a Map keyed by sessionId.
 * No durability beyond the lifetime of the harness-server process.
 *
 * Useful as the default for tests, for single-process scripted runs, and for
 * substrate-backed flows where the harness lives in an ephemeral sandbox and
 * cross-process resume isn't possible anyway.
 *
 * Idempotency by entry `uuid` per the SDK contract: an append of an entry
 * whose `uuid` is already present is a no-op. This makes retries and bulk
 * `importSessionToStore()` replays safe.
 */
export class MemorySessionStore implements SessionStore {
  private readonly bySession = new Map<string, SessionStoreEntry[]>();

  async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
    const list = this.bySession.get(key.sessionId) ?? [];
    const seenUuids = new Set(
      list.map((e) => e.uuid).filter((u): u is string => typeof u === "string"),
    );
    for (const entry of entries) {
      if (entry.uuid && seenUuids.has(entry.uuid)) continue;
      list.push(entry);
      if (entry.uuid) seenUuids.add(entry.uuid);
    }
    this.bySession.set(key.sessionId, list);
  }

  async load(key: SessionKey): Promise<SessionStoreEntry[] | null> {
    const list = this.bySession.get(key.sessionId);
    return list ? [...list] : null;
  }

  /** Test introspection: number of entries currently held for a sessionId. */
  size(sessionId: string): number {
    return this.bySession.get(sessionId)?.length ?? 0;
  }
}
