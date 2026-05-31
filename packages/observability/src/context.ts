import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Async-context store for the GenAI conversation id (`gen_ai.conversation.id`).
 *
 * Why this exists: the spec recommends tagging every span in a single
 * conversation/thread with the same `gen_ai.conversation.id`. In ComputerAgent,
 * that id IS the harness `sessionId`. We can't pass it explicitly through
 * every span-creation point inside the OtelAuditSink (and we definitely don't
 * want users to thread it through their own observe() calls), so we stash it
 * in an AsyncLocalStorage keyed to the current execution context.
 *
 * Mirrors Python TraceKit's `contextvars`-based `set_conversation_id` /
 * `get_conversation_id` pair — JS `AsyncLocalStorage` is the direct analogue.
 */

const conversationIdStore = new AsyncLocalStorage<string>();

/**
 * Read the active conversation id for the current async context. Returns
 * `undefined` if nothing has been set in this branch — callers should treat
 * that as "no conversation tag should be attached to this span".
 */
export function getConversationId(): string | undefined {
  const stored = conversationIdStore.getStore();
  // Treat the empty-string sentinel (used by enterConversation's disposer) as
  // "no conversation set" so callers can just check `if (id) {...}`.
  return stored ? stored : undefined;
}

/**
 * Run `fn` with `conversationId` bound to the active async context. The id is
 * scoped to the synchronous + async work `fn` performs and is automatically
 * cleared when `fn` resolves/rejects. Nested `withConversationId` calls shadow
 * outer ones for the duration of the inner block — never globally.
 *
 * Use this pattern for the duration of a single agent invocation:
 *
 *   await withConversationId(sessionId, async () => {
 *     // every span created in here picks up gen_ai.conversation.id = sessionId
 *   });
 */
export function withConversationId<T>(conversationId: string, fn: () => T | Promise<T>): Promise<T> {
  return Promise.resolve(conversationIdStore.run(conversationId, fn));
}

/**
 * Imperatively set the conversation id for the **current** async context.
 *
 * Prefer `withConversationId` whenever you control the boundary — it
 * auto-cleans. `enterConversation` exists for the case where the boundary is
 * external (e.g. an HTTP request handler calling into framework code that
 * doesn't await a wrapping callback). Returns a `dispose` function the caller
 * MUST call to clear the id.
 *
 * Implementation: AsyncLocalStorage has no public "set on the active store"
 * primitive — `enterWith` enters a new store for this branch. The returned
 * disposer calls `disable()` is overkill (it kills the global ALS), so we
 * instead use a sentinel "" to mean "no conversation" and let the next
 * `enterWith` overwrite it.
 */
export function enterConversation(conversationId: string): () => void {
  conversationIdStore.enterWith(conversationId);
  return () => {
    conversationIdStore.enterWith("");
  };
}
