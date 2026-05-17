// Public surface of @computeragent/protocol. Internals stay internal.

export * from "./identity-source.js";
export * from "./harness-rest.js";
export * from "./sse-events.js";
export * from "./contracts.js";
export { SessionStoreConfig } from "./session-store-config.js";
export type { Logger, LogLevel, CreateLoggerOptions } from "./logger.js";
export { createLogger, nopLogger } from "./logger.js";
export type {
  SDKMessage,
  SDKAssistantMessage,
  SDKUserMessage,
  SDKResultMessage,
  SDKSystemMessage,
  SDKPartialAssistantMessage,
  SDKCompactBoundaryMessage,
  ClaudeAgentOptions,
  PermissionMode,
  CanUseTool,
  PermissionResult,
  SessionStore,
  SessionStoreEntry,
  SessionKey,
} from "./sdk-passthrough.js";
