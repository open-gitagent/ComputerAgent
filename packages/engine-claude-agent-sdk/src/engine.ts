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

    // SessionStore wiring. Strategy:
    //   - Always pass `sessionStore` when set (so the SDK appends turn
    //     entries).
    //   - Always pin `sessionId` to a deterministic UUIDv5 derived from
    //     the harness sessionId. This makes the SDK write+read under the
    //     SAME key across turns; without it the SDK auto-generates a fresh
    //     UUID per turn and the next turn can't find anything to resume.
    //   - Only pass `resume: <uuid>` when prior entries actually exist
    //     under that key. The SDK errors when asked to resume a UUID with
    //     no prior data.
    const engineUuid = deriveEngineUuid(ctx.sessionId);
    let storeOpts: {
      sessionStore?: typeof ctx.sessionStore;
      sessionId?: string;
      resume?: string;
    } = {};
    if (ctx.sessionStore) {
      const prior = await ctx.sessionStore.load({
        projectKey: PROJECT_KEY,
        sessionId: engineUuid,
      });
      if (prior && prior.length > 0) {
        // Resuming an existing session: pass `resume` only. The Claude SDK
        // uses the resumed session's id internally for future appends.
        storeOpts = { sessionStore: ctx.sessionStore, resume: engineUuid };
      } else {
        // Fresh session under our deterministic key: pin `sessionId` so
        // appends land under the same key the next turn will look up.
        storeOpts = { sessionStore: ctx.sessionStore, sessionId: engineUuid };
      }
    }

    const options: ClaudeAgentOptions = {
      ...ctx.options,
      cwd: ctx.workdir,
      env: { ...ctx.envs },
      includePartialMessages: true,
      abortController,
      canUseTool: buildCanUseTool(ctx.onPermissionRequest),
      ...(ctx.budget?.maxUsd !== undefined ? { maxBudgetUsd: ctx.budget.maxUsd } : {}),
      ...storeOpts,
    };

    for await (const message of query({ prompt, options })) {
      if (ctx.abortSignal.aborted) break;
      yield { kind: "sdk_message", payload: message };
    }
  }
}

/**
 * Project key used when probing the SessionStore. Stable across processes so
 * a session written by one harness can be loaded by another against the same
 * store. Engines for other projects should use their own constants.
 */
const PROJECT_KEY = "computeragent";

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
