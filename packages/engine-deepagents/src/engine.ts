import type {
  EngineCapabilities,
  EngineContext,
  EngineDriver,
  EngineEvent,
  Logger,
  UserMessage,
} from "@computeragent/protocol";
import { nopLogger } from "@computeragent/protocol";

const CAPABILITIES: EngineCapabilities = {
  streamingInput: true,
  partialMessages: false,   // LangGraph emits message-level chunks, not token deltas (yet)
  permissionCallback: false, // tool gating deferred — gateable via LangGraph middleware in a follow-up
  sessions: true,           // LangGraph checkpointer handles in-process resume
  budget: false,            // no built-in cost cap
};

/**
 * Forward-compatible options shape. Anything in `ctx.options` is opaque
 * passthrough — the harness already forwards it from the wire. The engine
 * consults a few well-known keys:
 *   - `model`:        string, e.g. "claude-sonnet-4-5-20250929"
 *   - `systemPrompt`: string, appended to deepagents' default system prompt
 *   - `temperature`:  number, applied to the ChatAnthropic instance
 *   - `maxTurns`:     reserved (deepagents doesn't expose a turn cap today)
 */
interface DeepAgentsOptions {
  readonly model?: string;
  readonly systemPrompt?: string;
  readonly temperature?: number;
  readonly maxTurns?: number;
}

/**
 * EngineDriver implementation backed by `deepagents`.
 *
 * Architecture mirrors engine-gitagent: each user message in
 * `ctx.userMessageQueue` triggers a fresh `agent.stream()` call; LangGraph's
 * checkpointer + a stable thread_id (we use `ctx.sessionId`) handles
 * multi-turn memory in-process.
 *
 * Each LangGraph stream chunk is wrapped as `{kind: "sdk_message", payload}`
 * so downstream consumers see them via the same SSE event channel as the
 * other engines. Token usage is extracted from the final state's
 * `usage_metadata` and emitted as a `ca_usage_snapshot` BEFORE the synthetic
 * `result` terminator that triggers the SDK's chat-handle end-of-turn
 * detection (see issue #2 fix).
 */
export class DeepAgentsEngine implements EngineDriver<DeepAgentsOptions> {
  readonly name = "deepagents";
  readonly capabilities = CAPABILITIES;

  async *startSession(
    ctx: EngineContext<DeepAgentsOptions>,
  ): AsyncIterable<EngineEvent> {
    const log = ctx.logger ?? nopLogger;
    // Lazy import — deepagents pulls in a heavy LangChain dep tree (~150MB).
    // Loading it inside startSession means importers of @computeragent/engine-deepagents
    // only pay the cost when the engine actually runs.
    const [{ createDeepAgent, LocalShellBackend }, { ChatAnthropic }, { MemorySaver }] = await Promise.all([
      import("deepagents"),
      import("@langchain/anthropic"),
      import("@langchain/langgraph"),
    ]);

    const modelName = ctx.options.model ?? "claude-sonnet-4-5-20250929";
    const apiKey =
      ctx.envs.ANTHROPIC_API_KEY ??
      (typeof process !== "undefined" ? process.env.ANTHROPIC_API_KEY : undefined);
    if (!apiKey) {
      throw new Error(
        "engine-deepagents: ANTHROPIC_API_KEY missing — pass it via `envs` on the ComputerAgent constructor.",
      );
    }

    const model = new ChatAnthropic({
      model: stripProviderPrefix(modelName),
      apiKey,
      ...(ctx.options.temperature !== undefined ? { temperature: ctx.options.temperature } : {}),
    });

    // MemorySaver is in-process only — fine for the lifetime of one session.
    // Cross-process resume would need a custom checkpointer mapped to our
    // SessionStore; deferred for now.
    const checkpointer = new MemorySaver();
    const threadId = ctx.sessionId;

    // Bind filesystem + shell to the substrate's workdir so write_file/read_file
    // produce real files the substrate FS API can fetch, and `execute` runs
    // real shell commands. Without this deepagents falls back to StateBackend
    // (a virtual in-memory FS, no shell) — making skills that shell out unusable.
    const backend = new LocalShellBackend({ rootDir: ctx.workdir });
    await backend.initialize();

    const agent = createDeepAgent({
      model,
      checkpointer,
      backend,
      ...(ctx.options.systemPrompt ? { systemPrompt: ctx.options.systemPrompt } : {}),
    });

    log.info("engine.start", {
      engine: "deepagents",
      sessionId: ctx.sessionId,
      model: stripProviderPrefix(modelName),
      workdir: ctx.workdir,
      backend: "local-shell",
    });

    // One outer iteration = one user message = one fresh stream call.
    // The checkpointer + threadId carry conversation state across turns.
    for await (const userMsg of ctx.userMessageQueue) {
      if (ctx.abortSignal.aborted) break;

      const userText = flattenContent(userMsg.content);
      const turnStartedAt = Date.now();
      log.info("engine.turn.start", {
        engine: "deepagents",
        sessionId: ctx.sessionId,
        userTextLen: userText.length,
      });
      const input = { messages: [{ role: "user" as const, content: userText }] };
      const config = {
        configurable: { thread_id: threadId },
        signal: ctx.abortSignal,
      };

      let lastUsage: { input_tokens?: number; output_tokens?: number } | undefined;
      let finalText = "";
      let priorMsgCount = 0;

      try {
        // Stream LangGraph events in "values" mode — emits the full state on each
        // step. We forward every chunk so downstream tools can inspect the state.
        const stream = await agent.stream(input, { ...config, streamMode: "values" });
        for await (const chunk of stream as AsyncIterable<unknown>) {
          if (ctx.abortSignal.aborted) break;
          yield { kind: "sdk_message", payload: chunk };

          // Inspect the latest message for usage metadata + assistant text.
          const messages = extractMessagesFromChunk(chunk);
          // Log only NEW messages per chunk so each tool_use/tool_result lands once.
          const newMsgs = messages.slice(priorMsgCount);
          priorMsgCount = messages.length;
          for (const m of newMsgs) logDeepAgentMessage(log, ctx.sessionId, m);

          const last = messages[messages.length - 1];
          if (last) {
            if (typeof last.content === "string" && last.content.trim()) {
              finalText = last.content;
            } else if (Array.isArray(last.content)) {
              const textParts = last.content
                .filter((b): b is { type: "text"; text: string } => (b as { type?: string }).type === "text")
                .map((b) => b.text);
              if (textParts.length > 0) finalText = textParts.join("");
            }
            if (last.usage_metadata) lastUsage = last.usage_metadata;
          }
        }
      } catch (err) {
        log.error("engine.error", {
          engine: "deepagents",
          sessionId: ctx.sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }

      // Emit usage snapshot BEFORE the result terminator (per issue #2 ordering).
      if (lastUsage && (lastUsage.input_tokens !== undefined || lastUsage.output_tokens !== undefined)) {
        log.debug("engine.usage", {
          sessionId: ctx.sessionId,
          inputTokens: lastUsage.input_tokens,
          outputTokens: lastUsage.output_tokens,
        });
        yield {
          kind: "ca_usage_snapshot",
          ...(lastUsage.input_tokens !== undefined ? { inputTokens: lastUsage.input_tokens } : {}),
          ...(lastUsage.output_tokens !== undefined ? { outputTokens: lastUsage.output_tokens } : {}),
          costSemantic: "delta",   // LangChain reports per-call, not cumulative
        };
      }

      // Synthetic turn terminator so the SDK's openTurnEventStream detects
      // end-of-turn and yields ca_session_ended to the ChatHandle. Same pattern
      // engine-gitagent uses — gitclaw emits a real `system+session_end` we
      // pass through; deepagents has no equivalent, so we synthesize.
      yield {
        kind: "sdk_message",
        payload: {
          type: "result",
          subtype: "success",
          result: finalText,
          ...(lastUsage ? { usage: lastUsage } : {}),
        },
      };
      log.info("engine.turn.end", {
        engine: "deepagents",
        sessionId: ctx.sessionId,
        durationMs: Date.now() - turnStartedAt,
        finalTextLen: finalText.length,
      });
    }
  }
}

/**
 * Pure log emission for a single LangChain BaseMessage (already destructured
 * from a `messages[]` array). LangChain messages expose `_getType()` for role
 * and `tool_calls` (when assistant chose to call tools).
 */
function logDeepAgentMessage(
  log: Logger,
  sessionId: string,
  msg: { content?: unknown; _getType?: () => string; tool_calls?: Array<{ name: string; id?: string }>; name?: string; tool_call_id?: string },
): void {
  const role = typeof msg._getType === "function" ? msg._getType() : "?";
  if (msg.tool_calls && msg.tool_calls.length > 0) {
    for (const tc of msg.tool_calls) {
      log.debug("engine.tool_use", { sessionId, name: tc.name, callId: tc.id });
    }
    return;
  }
  if (role === "tool") {
    const bytes = typeof msg.content === "string" ? msg.content.length : JSON.stringify(msg.content ?? "").length;
    log.debug("engine.tool_result", { sessionId, name: msg.name, callId: msg.tool_call_id, bytes });
    return;
  }
  if (role === "ai" || role === "assistant") {
    if (typeof msg.content === "string" && msg.content.trim()) {
      log.debug("engine.assistant_text", { sessionId, textLen: msg.content.length });
    } else if (Array.isArray(msg.content)) {
      const textLen = msg.content
        .filter((b): b is { type: string; text: string } => (b as { type?: string }).type === "text")
        .reduce((n, b) => n + (b.text?.length ?? 0), 0);
      if (textLen > 0) log.debug("engine.assistant_text", { sessionId, textLen });
    }
  }
}

/**
 * `claude-agent-sdk` style model strings include `anthropic:` or similar
 * prefixes that ChatAnthropic doesn't accept. Strip and pass through.
 */
function stripProviderPrefix(modelName: string): string {
  const idx = modelName.indexOf(":");
  if (idx < 0) return modelName;
  return modelName.slice(idx + 1);
}

function flattenContent(content: UserMessage["content"]): string {
  if (typeof content === "string") return content;
  return content
    .map((block) => {
      const b = block as { type: string; text?: string };
      return b.type === "text" && typeof b.text === "string" ? b.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

/**
 * LangGraph "values" stream chunks have shape `{messages: [...], ...}`.
 * Extract the messages array defensively (some chunks may be partial state).
 */
function extractMessagesFromChunk(
  chunk: unknown,
): Array<{ content?: unknown; usage_metadata?: { input_tokens?: number; output_tokens?: number } }> {
  if (typeof chunk !== "object" || chunk === null) return [];
  const msgs = (chunk as { messages?: unknown }).messages;
  if (!Array.isArray(msgs)) return [];
  return msgs as Array<{ content?: unknown; usage_metadata?: { input_tokens?: number; output_tokens?: number } }>;
}
