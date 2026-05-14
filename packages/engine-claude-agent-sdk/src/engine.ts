import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type {
  ClaudeAgentOptions,
  EngineCapabilities,
  EngineContext,
  EngineDriver,
  EngineEvent,
  UserMessage,
} from "@computeragent/protocol";
import { buildCanUseTool } from "./permission-bridge.js";
import { deriveEngineUuid } from "./derive-uuid.js";

const CAPABILITIES: EngineCapabilities = {
  streamingInput: true,
  partialMessages: true,
  permissionCallback: true,
  sessions: true,
  budget: true,
};

/**
 * EngineDriver implementation backed by @anthropic-ai/claude-agent-sdk.
 *
 * Owns:
 *   - Adapting our streaming-input queue (UserMessage[]) to the SDK's
 *     AsyncIterable<SDKUserMessage>.
 *   - Forwarding every SDKMessage as `EngineEvent { kind: "sdk_message" }`
 *     verbatim — the harness server emits these as SSE `event: sdk_message`.
 *   - Wiring permission callbacks via the bridge.
 *
 * Does NOT own:
 *   - Translation from GAP/identity → ClaudeAgentOptions (that's the loader's job).
 *   - HTTP routing or SSE serialization (framework's job).
 */
export class ClaudeAgentEngine implements EngineDriver<ClaudeAgentOptions> {
  readonly name = "claude-agent-sdk";
  readonly capabilities = CAPABILITIES;

  async *startSession(
    ctx: EngineContext<ClaudeAgentOptions>,
  ): AsyncIterable<EngineEvent> {
    const prompt = adaptUserMessages(ctx.userMessageQueue, ctx.sessionId);
    const abortController = signalToController(ctx.abortSignal);

    const options: ClaudeAgentOptions = {
      ...ctx.options,
      cwd: ctx.workdir,
      env: { ...ctx.envs },
      includePartialMessages: true,
      abortController,
      canUseTool: buildCanUseTool(ctx.onPermissionRequest),
      ...(ctx.budget?.maxUsd !== undefined ? { maxBudgetUsd: ctx.budget.maxUsd } : {}),
      // When the framework provides a SessionStore, we wire it through and
      // ask the SDK to resume under a deterministic UUIDv5 derived from the
      // harness sessionId. The SDK's load() returns null on first turn (no
      // prior entries) and replays prior transcript on subsequent turns.
      ...(ctx.sessionStore
        ? { sessionStore: ctx.sessionStore, resume: deriveEngineUuid(ctx.sessionId) }
        : {}),
    };

    for await (const message of query({ prompt, options })) {
      if (ctx.abortSignal.aborted) break;
      yield { kind: "sdk_message", payload: message };
    }
  }
}

/**
 * Bridges our `AsyncIterable<UserMessage>` to the SDK's expected
 * `AsyncIterable<SDKUserMessage>`. The SDK's shape requires a `session_id` on
 * each message — we synthesize one if the host hasn't supplied one.
 */
async function* adaptUserMessages(
  queue: AsyncIterable<UserMessage>,
  sessionId: string = "computeragent-session",
): AsyncIterable<SDKUserMessage> {
  for await (const m of queue) {
    yield {
      type: "user",
      session_id: sessionId,
      message: { role: "user", content: m.content as never },
      parent_tool_use_id: null,
    };
  }
}

/** Wraps an AbortSignal in a fresh controller the SDK can hold a reference to. */
function signalToController(signal: AbortSignal): AbortController {
  const ctrl = new AbortController();
  if (signal.aborted) ctrl.abort();
  else signal.addEventListener("abort", () => ctrl.abort(), { once: true });
  return ctrl;
}
