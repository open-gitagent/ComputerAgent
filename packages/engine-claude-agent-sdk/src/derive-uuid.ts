import { v5 as uuidv5 } from "uuid";

/**
 * Project-stable UUIDv5 namespace for deriving Claude SDK session UUIDs from
 * harness-side session ids. Generated once; never changes.
 */
const NAMESPACE_COMPUTERAGENT_SESSION = "f8d9cb1a-3e7e-4d8d-9aa4-1d3f8d7b6c2e";

/**
 * Deterministically derive a Claude Agent SDK session UUID from a harness
 * `sessionId`. Same input → same output, always — no stored mapping needed
 * to translate between the harness `sess_xxx` format and the SDK's
 * `Options.resume` UUID requirement.
 *
 * The Claude SDK's `load(key)` returns null on first turn under a fresh UUID;
 * the SDK creates a new session under it. On subsequent turns the same UUID
 * loads the prior transcript and resumes.
 *
 * Pure function. No state, no I/O.
 */
export function deriveEngineUuid(sessionId: string): string {
  return uuidv5(sessionId, NAMESPACE_COMPUTERAGENT_SESSION);
}
