/**
 * SessionStore replay helpers for engines without native sessionStore support.
 *
 * The Claude Agent SDK consumes a `SessionStore` directly; engines like
 * gitclaw and (future) Codex/OpenCode/Gemini-CLI do not. For those engines we
 * synthesize "resume" by:
 *
 *   1. loading prior conversation entries from the store at turn start,
 *   2. rendering them into a system-prompt suffix the underlying engine
 *      treats as context,
 *   3. appending each new turn's user + assistant text back to the store.
 *
 * The store entries are SDK-agnostic JSON in the shape Claude SDK already
 * uses (`SessionStoreEntry = { type, uuid?, timestamp?, ...rest }`), so a
 * single backend (file, Mongo, Redis, ...) can hold transcripts from any mix
 * of engines.
 */
import { createHash } from "node:crypto";
import type { SessionStore, SessionStoreEntry } from "@computeragent/protocol";

/** Project key used when reading/writing through the SessionStore. */
export const PROJECT_KEY = "computeragent";

/** Render prior entries as a system-prompt suffix the engine can consume. */
export function renderPriorContext(entries: SessionStoreEntry[]): string | null {
  const turns: string[] = [];
  for (const e of entries) {
    if (e.type === "ca_user" && typeof e.text === "string") {
      turns.push(`user: ${e.text}`);
    } else if (e.type === "ca_assistant" && typeof e.text === "string") {
      turns.push(`assistant: ${e.text}`);
    }
  }
  if (turns.length === 0) return null;
  return (
    "# Prior conversation (restored from session store)\n" +
    "Treat the following exchange as already part of your conversation history.\n\n" +
    turns.join("\n")
  );
}

/** Produce a stable uuid for an entry from its content. Idempotency by hash. */
function entryUuid(role: "user" | "assistant", text: string, ordinal: number): string {
  const hash = createHash("sha256").update(`${role}:${ordinal}:${text}`).digest("hex");
  // Format as a UUID-ish string so adapters that index by uuid work.
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    hash.slice(12, 16),
    hash.slice(16, 20),
    hash.slice(20, 32),
  ].join("-");
}

/** Append a user turn to the store. */
export async function appendUserTurn(
  store: SessionStore,
  sessionId: string,
  text: string,
  ordinal: number,
): Promise<void> {
  await store.append(
    { projectKey: PROJECT_KEY, sessionId },
    [
      {
        type: "ca_user",
        uuid: entryUuid("user", text, ordinal),
        timestamp: new Date().toISOString(),
        text,
      },
    ],
  );
}

/** Append an assistant text response to the store. */
export async function appendAssistantTurn(
  store: SessionStore,
  sessionId: string,
  text: string,
  ordinal: number,
): Promise<void> {
  if (!text) return;
  await store.append(
    { projectKey: PROJECT_KEY, sessionId },
    [
      {
        type: "ca_assistant",
        uuid: entryUuid("assistant", text, ordinal),
        timestamp: new Date().toISOString(),
        text,
      },
    ],
  );
}
