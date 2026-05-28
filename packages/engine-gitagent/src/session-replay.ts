/**
 * SessionStore replay helpers for engines without native sessionStore support.
 *
 * The Claude Agent SDK consumes a `SessionStore` directly; engines like
 * gitclaw and (future) Codex/OpenCode/Gemini-CLI do not. For those engines we
 * synthesize "resume" by:
 *
 *   1. loading prior conversation entries from the store at turn start,
 *   2. rendering them — sorted by `turnIndex` — into a system-prompt suffix
 *      the underlying engine treats as context,
 *   3. appending each new turn's user / assistant text back to the store
 *      with a monotonically increasing `turnIndex`.
 *
 * `turnIndex` is the canonical ordering key. The document on disk may
 * interleave appends (assistant turns persist mid-stream as they're emitted),
 * but sorting by `turnIndex` always yields true conversation order.
 *
 * Entries are SDK-agnostic JSON in the shape Claude SDK already uses
 * (`SessionStoreEntry = { type, uuid?, timestamp?, ...rest }`), so a single
 * backend (file, Mongo, Redis, ...) can hold transcripts from any mix of
 * engines.
 */
import { createHash } from "node:crypto";
import type { SessionStore, SessionStoreEntry } from "@open-gitagent/protocol";

/** Project key used when reading/writing through the SessionStore. */
export const PROJECT_KEY = "computeragent";

interface ReplayEntry extends SessionStoreEntry {
  turnIndex?: number;
  text?: string;
}

/**
 * Compute the next turnIndex to use for new entries given the prior set.
 * Entries without a turnIndex (legacy or non-replay entries) are treated as
 * older than anything indexed.
 */
export function nextTurnIndex(prior: SessionStoreEntry[]): number {
  let max = -1;
  for (const e of prior as ReplayEntry[]) {
    if (typeof e.turnIndex === "number" && e.turnIndex > max) max = e.turnIndex;
  }
  return max + 1;
}

/** Render prior entries — sorted by turnIndex — as a system-prompt suffix. */
export function renderPriorContext(entries: SessionStoreEntry[]): string | null {
  const replayEntries = (entries as ReplayEntry[]).filter(
    (e) => (e.type === "ca_user" || e.type === "ca_assistant") && typeof e.text === "string",
  );
  if (replayEntries.length === 0) return null;
  const sorted = [...replayEntries].sort((a, b) => {
    const ai = a.turnIndex ?? -1;
    const bi = b.turnIndex ?? -1;
    return ai - bi;
  });
  const turns = sorted.map((e) =>
    e.type === "ca_user" ? `user: ${e.text}` : `assistant: ${e.text}`,
  );
  return (
    "# Prior conversation (restored from session store)\n" +
    "Treat the following exchange as already part of your conversation history.\n\n" +
    turns.join("\n")
  );
}

/**
 * Mutable turn counter shared between user / assistant appends so they
 * interleave in true conversation order regardless of when they hit the
 * store. Construct once per startSession() with `nextTurnIndex(prior)`.
 */
export class TurnIndexer {
  constructor(private cursor: number) {}
  /** Reserve and return the next index, advancing the cursor. */
  next(): number {
    return this.cursor++;
  }
  /** Peek the next index without advancing. */
  peek(): number {
    return this.cursor;
  }
}

/** Append a user turn to the store. Idempotent by content+turnIndex hash. */
export async function appendUserTurn(
  store: SessionStore,
  sessionId: string,
  text: string,
  turnIndex: number,
): Promise<void> {
  await store.append(
    { projectKey: PROJECT_KEY, sessionId },
    [
      {
        type: "ca_user",
        uuid: entryUuid("user", turnIndex, text),
        timestamp: new Date().toISOString(),
        turnIndex,
        text,
      },
    ],
  );
}

/** Append an assistant text response. No-op on empty text. */
export async function appendAssistantTurn(
  store: SessionStore,
  sessionId: string,
  text: string,
  turnIndex: number,
): Promise<void> {
  if (!text) return;
  await store.append(
    { projectKey: PROJECT_KEY, sessionId },
    [
      {
        type: "ca_assistant",
        uuid: entryUuid("assistant", turnIndex, text),
        timestamp: new Date().toISOString(),
        turnIndex,
        text,
      },
    ],
  );
}

/** Content-stable uuid derived from role + turnIndex + text. */
function entryUuid(role: "user" | "assistant", turnIndex: number, text: string): string {
  const hash = createHash("sha256").update(`${role}:${turnIndex}:${text}`).digest("hex");
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    hash.slice(12, 16),
    hash.slice(16, 20),
    hash.slice(20, 32),
  ].join("-");
}
