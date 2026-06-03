import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type {
  ClaudeAgentOptions,
  EngineCapabilities,
  EngineContext,
  EngineDriver,
  EngineEvent,
  UserMessage,
} from "@open-gitagent/protocol";
import { nopLogger } from "@open-gitagent/protocol";
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
    const log = ctx.logger ?? nopLogger;
    const turnStartedAt = Date.now();
    const model = (ctx.options as { model?: string }).model;
    log.info("engine.start", {
      engine: "claude-agent-sdk",
      sessionId: ctx.sessionId,
      model,
      workdir: ctx.workdir,
    });
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

    // `temperature` is part of our cross-engine options surface (Wedge 1.7)
    // but `@anthropic-ai/claude-agent-sdk` v0.2.x's public `Options` type
    // doesn't expose it. Warn once per process so callers know it's a no-op
    // here — they can switch to harness="gitagent" if temperature matters,
    // or wait for the upstream SDK to expose the field.
    const flatTemperature = (ctx.options as { temperature?: number }).temperature;
    if (flatTemperature !== undefined) warnTemperatureUnsupported();

    const options: ClaudeAgentOptions = {
      ...stripFlatTemperature(ctx.options),
      cwd: ctx.workdir,
      // Merge essential host envs (HOME, PATH, ...) with caller-supplied envs.
      // The Claude CLI subprocess writes transcript-mirror JSONL files to
      // $HOME/.claude/projects/<projectKey>/<sessionId>.jsonl, and the SDK's
      // mirror watcher reads them back to call sessionStore.append(). If HOME
      // isn't in the env we pass to query(), the subprocess can't resolve the
      // write path and silently drops every mirror frame. ctx.envs alone
      // typically only carries API keys — that's not enough.
      //
      // IS_SANDBOX=1: the harness always runs the CLI with permissionMode
      // bypassPermissions (→ --dangerously-skip-permissions). Claude Code
      // refuses that flag when running as root ("cannot be used with
      // root/sudo privileges") and exits 1 — which is exactly what happens in
      // our containers (they run as uid 0). Since the CLI is already confined
      // to an isolated substrate workdir, declare IS_SANDBOX so skip-permissions
      // is allowed regardless of uid. Default first so ctx.envs can override.
      env: { IS_SANDBOX: "1", ...inheritEssentialHostEnv(), ...ctx.envs },
      includePartialMessages: true,
      abortController,
      canUseTool: buildCanUseTool(ctx.onPermissionRequest),
      ...(ctx.budget?.maxUsd !== undefined ? { maxBudgetUsd: ctx.budget.maxUsd } : {}),
      ...storeOpts,
    };

    try {
      for await (const message of query({ prompt, options })) {
        if (ctx.abortSignal.aborted) break;

        logSdkMessage(log, ctx.sessionId, message);

        // Surface token/cost telemetry BEFORE the message itself. SDKResultMessage
        // is the turn terminator — once the SDK consumer sees it, my issue #2
        // fix synthesizes a `ca_session_ended` and stops reading. So usage has
        // to land on the wire BEFORE the result, otherwise it's dropped. The
        // consumer (SDK aggregator) uses costSemantic="cumulative" to take the
        // max and sums the per-turn tokens. Never compute cost client-side — see #5.
        const snapshot = toUsageSnapshot(message);
        if (snapshot) {
          log.debug("engine.usage", {
            sessionId: ctx.sessionId,
            inputTokens: snapshot.kind === "ca_usage_snapshot" ? snapshot.inputTokens : undefined,
            outputTokens: snapshot.kind === "ca_usage_snapshot" ? snapshot.outputTokens : undefined,
            costUsd: snapshot.kind === "ca_usage_snapshot" ? snapshot.costUsd : undefined,
          });
          yield snapshot;
        }

        yield { kind: "sdk_message", payload: message };
      }
      log.info("engine.turn.end", {
        engine: "claude-agent-sdk",
        sessionId: ctx.sessionId,
        durationMs: Date.now() - turnStartedAt,
      });
    } catch (err) {
      log.error("engine.error", {
        engine: "claude-agent-sdk",
        sessionId: ctx.sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }
}

/**
 * Extract tool_use, tool_result, and assistant_text events from each
 * SDKMessage as it flows through. Pure log emission — no transformation.
 */
function logSdkMessage(log: { debug: (e: string, f?: Record<string, unknown>) => void }, sessionId: string, message: unknown): void {
  const m = message as {
    type?: string;
    message?: { content?: Array<{ type: string; name?: string; id?: string; text?: string; tool_use_id?: string; is_error?: boolean; content?: unknown }> };
  };
  if (m?.type === "assistant" && Array.isArray(m.message?.content)) {
    for (const block of m.message.content) {
      if (block.type === "tool_use") {
        log.debug("engine.tool_use", { sessionId, name: block.name, callId: block.id });
      } else if (block.type === "text" && typeof block.text === "string") {
        log.debug("engine.assistant_text", { sessionId, textLen: block.text.length });
      }
    }
  } else if (m?.type === "user" && Array.isArray(m.message?.content)) {
    for (const block of m.message.content) {
      if (block.type === "tool_result") {
        const bytes = typeof block.content === "string" ? block.content.length : JSON.stringify(block.content ?? "").length;
        log.debug("engine.tool_result", { sessionId, callId: block.tool_use_id, isError: block.is_error, bytes });
      }
    }
  }
}

/**
 * Translate an SDKMessage to a `ca_usage_snapshot` event if it carries usage data.
 * Currently only `SDKResultMessage` (success or error) does. Returns `undefined`
 * for every other message type so the caller can no-op.
 *
 * Field reads use snake_case (wire-side from Anthropic API) since the SDK
 * forwards Anthropic's JSON shape unchanged at runtime.
 */
function toUsageSnapshot(message: unknown): EngineEvent | undefined {
  const m = message as {
    type?: string;
    total_cost_usd?: number;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
  if (m?.type !== "result") return undefined;
  const u = m.usage;
  // Skip the snapshot if neither tokens nor cost are present — no signal to forward.
  if (!u && m.total_cost_usd === undefined) return undefined;

  return {
    kind: "ca_usage_snapshot",
    ...(u?.input_tokens !== undefined ? { inputTokens: u.input_tokens } : {}),
    ...(u?.output_tokens !== undefined ? { outputTokens: u.output_tokens } : {}),
    ...(u?.cache_creation_input_tokens !== undefined
      ? { cacheCreationInputTokens: u.cache_creation_input_tokens }
      : {}),
    ...(u?.cache_read_input_tokens !== undefined
      ? { cacheReadInputTokens: u.cache_read_input_tokens }
      : {}),
    ...(m.total_cost_usd !== undefined
      ? { costUsd: m.total_cost_usd, costSemantic: "cumulative" as const }
      : {}),
  };
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

/**
 * Forward the essential host environment so the Claude CLI subprocess can
 * resolve standard paths ($HOME, PATH, ...). Without these, the SDK's
 * transcript-mirror writes silently drop because the CLI can't find
 * $HOME/.claude/projects/ to write JSONL files into, which means
 * sessionStore.append() never fires for any session entry.
 *
 * Caller envs (api keys, etc.) override these on conflict.
 */
/**
 * Pure: snapshot the env vars the spawned harness subprocess needs from the
 * parent process. Includes the standard POSIX/XDG essentials plus the AWS
 * Bedrock envs the Claude Agent SDK reads when `CLAUDE_CODE_USE_BEDROCK=1`.
 * Exported for testability — the engine itself calls it inline.
 */
export function inheritEssentialHostEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of [
    "HOME",
    "PATH",
    "USER",
    "LOGNAME",
    "LANG",
    "LC_ALL",
    "CLAUDE_CONFIG_DIR",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    // AWS Bedrock — when CLAUDE_CODE_USE_BEDROCK=1, the Claude Agent SDK
    // switches transport to Bedrock and uses the standard AWS credential
    // chain. On EKS that means the IRSA-projected web-identity token at
    // AWS_WEB_IDENTITY_TOKEN_FILE + AWS_ROLE_ARN; locally it's the usual
    // AWS_PROFILE / shared-credentials flow. Pass these through so the
    // chain can find them inside the spawned harness subprocess.
    "CLAUDE_CODE_USE_BEDROCK",
    "AWS_REGION",
    "AWS_DEFAULT_REGION",
    "AWS_BEDROCK_MODEL_ID",
    "AWS_ROLE_ARN",
    "AWS_WEB_IDENTITY_TOKEN_FILE",
    "AWS_PROFILE",
    "AWS_SHARED_CREDENTIALS_FILE",
    "AWS_CONFIG_FILE",
  ]) {
    const v = process.env[k];
    if (v) out[k] = v;
  }
  return out;
}

/**
 * Drop the flat `temperature` shortcut before spreading into ClaudeAgentOptions.
 * The Claude Agent SDK v0.2.x doesn't accept `temperature` on `Options`, so
 * leaving it in would land as an unknown property (mostly harmless but noisy).
 * See Wedge 1.7.
 */
function stripFlatTemperature<T extends Record<string, unknown>>(
  opts: T,
): Omit<T, "temperature"> {
  const { temperature: _t, ...rest } = opts as T & { temperature?: number };
  return rest as Omit<T, "temperature">;
}

let temperatureWarned = false;
function warnTemperatureUnsupported(): void {
  if (temperatureWarned) return;
  temperatureWarned = true;
  // eslint-disable-next-line no-console
  console.warn(
    "[computeragent] `temperature` is set but the claude-agent-sdk engine (v0.2.x) " +
      "doesn't expose temperature on its public Options type — it has no effect. " +
      "Use `harness: \"gitagent\"` if temperature control matters, or wait for the " +
      "Anthropic SDK to add the field. (warned once per process)",
  );
}
