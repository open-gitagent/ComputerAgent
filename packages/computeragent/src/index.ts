/**
 * `computeragent` — the umbrella entry point.
 *
 * One-line install for the common case:
 *
 *   npm install computeragent
 *
 *   import { runTask, ComputerAgent, LocalSubstrate } from "computeragent";
 *
 * Re-exports the user-facing SDK plus the default `LocalSubstrate` so a
 * fresh project can get to a running agent without touching the scoped
 * `@computeragent/*` packages directly. For other substrates (E2B, VZVM)
 * or other session-store backends (Mongo, SQLite), install those scoped
 * packages alongside.
 */
export {
  ComputerAgent,
  ChatHandle,
  runTask,
  ttyApproval,
  HarnessProtocolError,
  UnknownEngineError,
  UnknownLoaderError,
  UnknownStoreError,
} from "@computeragent/sdk";
export type {
  ChatInput,
  ChatResult,
  ComputerAgentOptions,
  HarnessName,
  IdentityLoaderName,
  PermissionDecision,
  RunTaskOptions,
  SessionStoreKind,
  ToolCallContext,
  UsageRollup,
  Substrate,
  BootHarnessOptions,
  BootedHarness,
  FsTreeEntry,
  HarnessEvent,
  IdentitySource,
  UserMessage,
} from "@computeragent/sdk";

export { LocalSubstrate } from "@computeragent/runtime-local";
