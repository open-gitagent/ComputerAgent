import type { SessionKey, SessionStore } from "@open-gitagent/protocol";

/**
 * Wrap a SessionStore so every key it persists/reads is pinned to a single
 * `sessionId`, regardless of the id the Claude Agent SDK supplies.
 *
 * Why this exists: the SDK requires `Options.sessionId` (and `resume`) to be a
 * valid UUID, so the engine hands it a deterministic `deriveEngineUuid(sessionId)`
 * rather than the human-readable harness sessionId (`agentos-<agent>-<hex>`).
 * Left unwrapped, the SDK then calls `sessionStore.append({ sessionId: <uuid> })`,
 * and the durable row lands under the UUID — diverging from the harness sessionId
 * the dashboard (and gitagent sessions) key on.
 *
 * Pinning the persisted key to the harness `sessionId` keeps the UUID purely
 * in-flight: the store row's `_id` is the same string everywhere (dashboard
 * `chat_sessions`, the transcript read, gitagent). The translation is a pure
 * rewrite of `key.sessionId`; `projectKey`/`subpath` pass through untouched, so
 * resume still works (the SDK loads by its UUID key → we rewrite → same row).
 *
 * Optional methods are forwarded only when the underlying store implements them
 * (the SDK probes for `delete`/`listSubkeys` existence).
 */
export function pinSessionStoreKey(store: SessionStore, sessionId: string): SessionStore {
  const pin = <K extends { sessionId: string }>(key: K): K => ({ ...key, sessionId });

  const wrapped: SessionStore = {
    append: (key: SessionKey, entries) => store.append(pin(key), entries),
    load: (key: SessionKey) => store.load(pin(key)),
  };

  if (store.listSessions) {
    wrapped.listSessions = (projectKey: string) => store.listSessions!(projectKey);
  }
  if (store.listSessionSummaries) {
    wrapped.listSessionSummaries = (projectKey: string) => store.listSessionSummaries!(projectKey);
  }
  if (store.delete) {
    wrapped.delete = (key: SessionKey) => store.delete!(pin(key));
  }
  if (store.listSubkeys) {
    wrapped.listSubkeys = (key) => store.listSubkeys!(pin(key));
  }

  return wrapped;
}
