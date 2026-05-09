/**
 * Type-only re-exports from `@anthropic-ai/claude-agent-sdk`.
 *
 * The Harness Protocol forwards `SDKMessage` values verbatim inside `event: sdk_message`
 * SSE events when the engine is `claude-agent-sdk`. Consumers that already speak the
 * SDK's types can decode the stream with zero translation. We do not import any
 * runtime values here — types only — so this file adds no bundle size.
 */
export type {
  SDKMessage,
  SDKAssistantMessage,
  SDKUserMessage,
  SDKResultMessage,
  SDKSystemMessage,
  SDKPartialAssistantMessage,
  SDKCompactBoundaryMessage,
  Options as ClaudeAgentOptions,
  PermissionMode,
  CanUseTool,
  PermissionResult,
} from "@anthropic-ai/claude-agent-sdk";
