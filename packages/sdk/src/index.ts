export { ComputerAgent } from "./computer-agent.js";
export { ChatHandle } from "./chat-handle.js";
export { runTask } from "./run-task.js";
export type { RunTaskOptions } from "./run-task.js";
export type {
  ChatInput,
  ChatResult,
  ComputerAgentOptions,
  HarnessName,
  IdentityLoaderName,
  PermissionDecision,
  SessionStoreKind,
  ToolCallContext,
  UsageRollup,
} from "./types.js";
export type { Substrate, BootHarnessOptions, BootedHarness } from "./substrate.js";
export type { HarnessEvent, IdentitySource, UserMessage } from "@computeragent/protocol";
export {
  HarnessProtocolError,
  UnknownEngineError,
  UnknownLoaderError,
  UnknownStoreError,
} from "./errors.js";
