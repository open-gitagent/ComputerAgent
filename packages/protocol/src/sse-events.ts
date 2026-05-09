import { z } from "zod";

/**
 * SSE event types emitted by `GET /v1/sessions/:id/events` and as the body of `POST /v1/chat`.
 *
 * Two families:
 *   - `sdk_message`: verbatim forwarding of the underlying engine's native message.
 *     For engines that ride on `@anthropic-ai/claude-agent-sdk`, the payload is an `SDKMessage`.
 *   - `ca_*`: ComputerAgent framing layered on top — session lifecycle, permissions, usage.
 *
 * Schemas validate the SHAPE; the inner `payload` of `sdk_message` is opaque (z.unknown())
 * because every engine emits a different native message union.
 */

const baseEvent = <T extends string>(kind: T) =>
  z.object({
    kind: z.literal(kind),
    sessionId: z.string(),
  });

/** Engine-native message forwarded verbatim. Shape depends on engine. */
export const SdkMessageEvent = baseEvent("sdk_message").extend({
  payload: z.unknown(),
});
export type SdkMessageEvent = z.infer<typeof SdkMessageEvent>;

/** First event on every stream — declares session metadata + capabilities. */
export const CaSessionStartedEvent = baseEvent("ca_session_started").extend({
  engine: z.string(),
  identity: z.object({
    name: z.string(),
    version: z.string(),
    sha: z.string().optional(),
  }),
  capabilities: z.object({
    streamingInput: z.boolean(),
    partialMessages: z.boolean(),
    permissionCallback: z.boolean(),
    sessions: z.boolean(),
    budget: z.boolean(),
  }),
});
export type CaSessionStartedEvent = z.infer<typeof CaSessionStartedEvent>;

/** Engine wants permission to call a tool — client must POST a decision. */
export const CaPermissionRequestEvent = baseEvent("ca_permission_request").extend({
  callId: z.string(),
  toolName: z.string(),
  input: z.unknown(),
  risk: z.enum(["low", "medium", "high", "destructive"]).optional(),
});
export type CaPermissionRequestEvent = z.infer<typeof CaPermissionRequestEvent>;

/** Periodic usage snapshot — token + cost telemetry. */
export const CaUsageSnapshotEvent = baseEvent("ca_usage_snapshot").extend({
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  cacheCreationInputTokens: z.number().int().nonnegative().optional(),
  cacheReadInputTokens: z.number().int().nonnegative().optional(),
  costUsd: z.number().nonnegative().optional(),
});
export type CaUsageSnapshotEvent = z.infer<typeof CaUsageSnapshotEvent>;

/** Terminal event — session is over. */
export const CaSessionEndedEvent = baseEvent("ca_session_ended").extend({
  reason: z.enum(["complete", "cancelled", "error", "budget_exceeded"]),
  errorMessage: z.string().optional(),
});
export type CaSessionEndedEvent = z.infer<typeof CaSessionEndedEvent>;

/** Discriminated union of every event the protocol emits. */
export const HarnessEvent = z.discriminatedUnion("kind", [
  SdkMessageEvent,
  CaSessionStartedEvent,
  CaPermissionRequestEvent,
  CaUsageSnapshotEvent,
  CaSessionEndedEvent,
]);
export type HarnessEvent = z.infer<typeof HarnessEvent>;
