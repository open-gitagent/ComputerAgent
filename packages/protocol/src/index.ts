// Public surface of @computeragent/protocol. Internals stay internal.

export * from "./identity-source.js";
export * from "./harness-rest.js";
export * from "./sse-events.js";
export * from "./contracts.js";
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
} from "./sdk-passthrough.js";
