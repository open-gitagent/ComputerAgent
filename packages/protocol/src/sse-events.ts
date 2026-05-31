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

/**
 * Periodic usage snapshot — token + cost telemetry.
 *
 * Token fields are per-message (tokens used by one LLM call). The SDK
 * aggregates them into `ChatResult.usage` via summation.
 *
 * `costSemantic` tells aggregators how to combine `costUsd` across multiple
 * snapshots — see the engine's contract. Cost is never computed client-side
 * from a price table; engines pass through whatever their provider returned.
 */
export const CaUsageSnapshotEvent = baseEvent("ca_usage_snapshot").extend({
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  cacheCreationInputTokens: z.number().int().nonnegative().optional(),
  cacheReadInputTokens: z.number().int().nonnegative().optional(),
  costUsd: z.number().nonnegative().optional(),
  costSemantic: z.enum(["cumulative", "delta"]).optional(),
});
export type CaUsageSnapshotEvent = z.infer<typeof CaUsageSnapshotEvent>;

/** Terminal event — session is over. */
export const CaSessionEndedEvent = baseEvent("ca_session_ended").extend({
  reason: z.enum(["complete", "cancelled", "error", "budget_exceeded"]),
  errorMessage: z.string().optional(),
});
export type CaSessionEndedEvent = z.infer<typeof CaSessionEndedEvent>;

/**
 * Resolution of a prior `ca_permission_request`. Emitted from
 * `POST /v1/sessions/:id/permission/:callId` after the resolver fires, so
 * audit sinks and replay consumers can correlate decisions with their
 * originating requests without polling the route.
 */
export const CaPermissionDecisionEvent = baseEvent("ca_permission_decision").extend({
  callId: z.string(),
  decision: z.enum(["allow", "deny", "modify"]),
  reason: z.string().optional(),
});
export type CaPermissionDecisionEvent = z.infer<typeof CaPermissionDecisionEvent>;

/**
 * Marks the boundary between user turns in a multi-turn session. Emitted for
 * the first turn (alongside `ca_session_started`) and for every subsequent
 * `POST /v1/sessions/:id/messages` that enqueues a new user message. Lets
 * span-based consumers open a fresh per-turn root (`invoke_agent` in OTel
 * GenAI terms) without inferring turn boundaries from sdk-message streams.
 *
 * `message` carries the user message that triggered this turn (the same one
 * that's about to be pushed to the engine's userMessageQueue). Surfaced on
 * the event stream so audit sinks can populate `gen_ai.input.messages`
 * without relying on engines to echo their prompts back — `claude-agent-sdk`
 * for one does not echo the initial prompt as an `sdk_message`, so this is
 * the only reliable source of the user's content.
 *
 * Optional for backward compatibility — older audit producers may omit it.
 */
export const CaTurnStartedEvent = baseEvent("ca_turn_started").extend({
  turnIndex: z.number().int().nonnegative(),
  message: z
    .object({
      role: z.literal("user"),
      content: z.union([
        z.string(),
        z.array(z.object({ type: z.string() }).passthrough()),
      ]),
    })
    .optional(),
});
export type CaTurnStartedEvent = z.infer<typeof CaTurnStartedEvent>;

/** Discriminated union of every event the protocol emits. */
export const HarnessEvent = z.discriminatedUnion("kind", [
  SdkMessageEvent,
  CaSessionStartedEvent,
  CaPermissionRequestEvent,
  CaPermissionDecisionEvent,
  CaTurnStartedEvent,
  CaUsageSnapshotEvent,
  CaSessionEndedEvent,
]);
export type HarnessEvent = z.infer<typeof HarnessEvent>;
