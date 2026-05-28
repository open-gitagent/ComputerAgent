import { query, type GCUserMessage, type QueryOptions } from "gitclaw";
import type {
  EngineCapabilities,
  EngineContext,
  EngineDriver,
  EngineEvent,
  SessionStoreEntry,
  UserMessage,
} from "@open-gitagent/protocol";
import { nopLogger } from "@open-gitagent/protocol";
import { buildPreToolUse } from "./permission-bridge.js";
import {
  appendAssistantTurn,
  appendUserTurn,
  nextTurnIndex,
  PROJECT_KEY,
  renderPriorContext,
  TurnIndexer,
} from "./session-replay.js";

const CAPABILITIES: EngineCapabilities = {
  streamingInput: true,
  partialMessages: true,
  permissionCallback: true,
  sessions: true,
  budget: false,
};

/** Subset of QueryOptions safe to forward from the loader. */
type GitclawForwardOptions = Pick<
  QueryOptions,
  "model" | "env" | "systemPrompt" | "systemPromptSuffix" | "maxTurns" | "constraints"
  | "allowedTools" | "disallowedTools" | "replaceBuiltinTools"
>;

/**
 * EngineDriver implementation backed by `gitclaw` (the gitagent bot).
 *
 * Multi-turn shape: `gitclaw.query()` is NOT streaming-input — its prompt
 * AsyncIterable is consumed for ONE turn, then the iterator terminates.
 * To support multi-turn agent.chat() on a single agent instance (issue #4),
 * the engine loops one-query-per-user-message: each new user message in
 * `ctx.userMessageQueue` triggers a fresh `query()` call with all prior
 * turns folded into `systemPromptSuffix` as restored context.
 *
 * Same context-restoration mechanism powers cross-process resume — the
 * difference is just where the prior turns live:
 *   - in-process multi-turn: in `accumulated`, in memory
 *   - cross-process resume:  in the SessionStore on disk, loaded at start
 *
 * Owns:
 *   - Adapting our streaming-input queue (UserMessage[]) to gitclaw's one-shot
 *     prompt iterables — one per user message.
 *   - Forwarding every GCMessage as `EngineEvent { kind: "sdk_message" }`
 *     verbatim — the harness server emits these as SSE `event: sdk_message`.
 *   - Wiring `preToolUse` to the framework's permission round-trip.
 *   - Persisting turns to SessionStore when configured (idempotent per turnIndex).
 *
 * Does NOT own:
 *   - GAP → gitclaw options translation (that's identity-gitagentprotocol's adapter).
 *   - Env injection (single-tenant: caller sets process.env before boot).
 */
export class GitAgentEngine implements EngineDriver<GitclawForwardOptions & { dir?: string }> {
  readonly name = "gitagent";
  readonly capabilities = CAPABILITIES;

  async *startSession(
    ctx: EngineContext<GitclawForwardOptions & { dir?: string }>,
  ): AsyncIterable<EngineEvent> {
    const log = ctx.logger ?? nopLogger;
    log.info("engine.start", {
      engine: "gitagent",
      sessionId: ctx.sessionId,
      model: (ctx.options as { model?: string }).model,
      workdir: ctx.workdir,
    });
    const store = ctx.sessionStore;
    const storeKey = { projectKey: PROJECT_KEY, sessionId: ctx.sessionId };

    // Load any prior conversation from disk. For a fresh session this is
    // empty; for a resumed session it carries the previous transcript.
    // `accumulated` is the in-memory mirror that grows over the lifetime
    // of this engine invocation, so subsequent in-process turns see prior
    // turns even when no SessionStore is configured.
    const accumulated: SessionStoreEntry[] = store ? (await store.load(storeKey)) ?? [] : [];
    const indexer = new TurnIndexer(nextTurnIndex(accumulated));

    const abortController = signalToController(ctx.abortSignal);
    const baseSuffix = ctx.options.systemPromptSuffix ?? "";

    // One outer iteration = one user message = one fresh `query()` call.
    // The framework keeps `userMessageQueue` open across multiple `agent.chat()`
    // calls (streamingInput=true at the wire), so this loop only exits when
    // /end-input is POSTed (agent.dispose()) or the abort signal fires.
    for await (const userMsg of ctx.userMessageQueue) {
      if (ctx.abortSignal.aborted) break;

      const userText = flattenContent(userMsg.content);
      const turnStartedAt = Date.now();

      // Persist + accumulate the user turn BEFORE running query() so that
      // if the turn errors out partway, the document still records the
      // message in turn-correct order.
      const userIndex = indexer.next();
      log.info("engine.turn.start", {
        engine: "gitagent",
        sessionId: ctx.sessionId,
        turnIndex: userIndex,
        userTextLen: userText.length,
      });
      if (store) {
        await appendUserTurn(store, ctx.sessionId, userText, userIndex);
      }
      accumulated.push({
        type: "ca_user",
        uuid: `inproc-user-${ctx.sessionId}-${userIndex}`,
        timestamp: new Date().toISOString(),
        turnIndex: userIndex,
        text: userText,
      } as SessionStoreEntry);

      // Compose systemPromptSuffix: gitclaw's prompt iterable carries ONLY
      // this turn's user message; everything before goes via suffix.
      // We exclude the just-pushed user message from the rendered context —
      // gitclaw sees it as the live prompt, not as restored history.
      const priorForSuffix = accumulated.slice(0, -1);
      const priorSuffix = renderPriorContext(priorForSuffix);
      const systemPromptSuffix = priorSuffix
        ? (baseSuffix ? `${baseSuffix}\n\n${priorSuffix}` : priorSuffix)
        : (baseSuffix || undefined);

      // Fold the flat `temperature` shortcut (set by `new ComputerAgent({...})`
      // or by the GAP loader from `agent.yaml`'s `model.constraints.temperature`)
      // into gitclaw's nested `constraints` object — that's where gitclaw
      // actually looks. See Wedge 1.7.
      const flatTemperature = (ctx.options as { temperature?: number }).temperature;
      const inheritedConstraints =
        (ctx.options as { constraints?: Record<string, unknown> }).constraints ?? {};
      const constraints: Record<string, unknown> =
        flatTemperature !== undefined
          ? { ...inheritedConstraints, temperature: flatTemperature }
          : inheritedConstraints;

      const options: QueryOptions = {
        prompt: singleMessageIterable(userText),
        dir: ctx.options.dir ?? ctx.workdir,
        sessionId: ctx.sessionId,
        abortController,
        hooks: { preToolUse: buildPreToolUse(ctx.onPermissionRequest) },
        ...stripDirAndFlatTemperature(ctx.options),
        ...(Object.keys(constraints).length > 0
          ? { constraints: constraints as QueryOptions["constraints"] }
          : {}),
        ...(systemPromptSuffix ? { systemPromptSuffix } : {}),
      };

      // Stream this turn's messages. Each assistant text turn we observe
      // gets persisted + accumulated so the next iteration sees it.
      try {
        for await (const message of query(options)) {
          if (ctx.abortSignal.aborted) break;

          logGitclawMessage(log, ctx.sessionId, message);

          // Emit usage BEFORE the message itself. gitclaw's session_end is
          // the turn terminator on the SDK side; if usage rides on the wire
          // after the terminator, the SDK consumer's already bailed and the
          // snapshot is dropped. (Same constraint as engine-claude-agent-sdk.)
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

          const text = extractAssistantText(message);
          if (text) {
            const assistantIndex = indexer.next();
            if (store) {
              await appendAssistantTurn(store, ctx.sessionId, text, assistantIndex);
            }
            accumulated.push({
              type: "ca_assistant",
              uuid: `inproc-assistant-${ctx.sessionId}-${assistantIndex}`,
              timestamp: new Date().toISOString(),
              turnIndex: assistantIndex,
              text,
            } as SessionStoreEntry);
          }
        }
        log.info("engine.turn.end", {
          engine: "gitagent",
          sessionId: ctx.sessionId,
          turnIndex: userIndex,
          durationMs: Date.now() - turnStartedAt,
        });
      } catch (err) {
        log.error("engine.error", {
          engine: "gitagent",
          sessionId: ctx.sessionId,
          turnIndex: userIndex,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    }
  }
}

/**
 * Pure log emission for gitclaw messages. gitclaw uses top-level
 * `type: "tool_use"` / `"tool_result"` (not nested inside assistant.content
 * like the Claude Agent SDK does), so the shape is simpler.
 */
function logGitclawMessage(
  log: { debug: (e: string, f?: Record<string, unknown>) => void },
  sessionId: string,
  message: unknown,
): void {
  const m = message as {
    type?: string;
    toolName?: string;
    toolCallId?: string;
    isError?: boolean;
    content?: unknown;
    args?: unknown;
  };
  if (m?.type === "tool_use") {
    log.debug("engine.tool_use", { sessionId, name: m.toolName, callId: m.toolCallId });
  } else if (m?.type === "tool_result") {
    const bytes = typeof m.content === "string" ? m.content.length : JSON.stringify(m.content ?? "").length;
    log.debug("engine.tool_result", { sessionId, callId: m.toolCallId, isError: m.isError, bytes });
  } else if (m?.type === "assistant" && typeof m.content === "string") {
    log.debug("engine.assistant_text", { sessionId, textLen: m.content.length });
  }
}

/**
 * Translate a gitclaw GCAssistantMessage to a `ca_usage_snapshot` event when it
 * carries usage data. gitclaw reports usage **per assistant message** as a delta
 * (one LLM call's tokens + cost, not running totals). The SDK aggregator SUMs
 * these — see `costSemantic: "delta"` in the protocol.
 *
 * Returns undefined for messages without usage (e.g. tool_use, tool_result,
 * system messages, deltas — gitclaw only attaches usage to assistant messages).
 *
 * Field names come from gitclaw's published shape:
 *   GCAssistantMessage.usage = { inputTokens, outputTokens, cacheReadTokens,
 *                                cacheWriteTokens, totalTokens, costUsd }
 */
function toUsageSnapshot(message: unknown): EngineEvent | undefined {
  const m = message as {
    type?: string;
    usage?: {
      inputTokens?: number;
      outputTokens?: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      costUsd?: number;
    };
  };
  if (m?.type !== "assistant" || !m.usage) return undefined;
  const u = m.usage;
  // Skip empty usage records — no signal worth a wire round-trip.
  if (
    u.inputTokens === undefined &&
    u.outputTokens === undefined &&
    u.costUsd === undefined
  ) {
    return undefined;
  }
  return {
    kind: "ca_usage_snapshot",
    ...(u.inputTokens !== undefined ? { inputTokens: u.inputTokens } : {}),
    ...(u.outputTokens !== undefined ? { outputTokens: u.outputTokens } : {}),
    // Map gitclaw's naming to the protocol's Anthropic-aligned naming.
    ...(u.cacheWriteTokens !== undefined
      ? { cacheCreationInputTokens: u.cacheWriteTokens }
      : {}),
    ...(u.cacheReadTokens !== undefined
      ? { cacheReadInputTokens: u.cacheReadTokens }
      : {}),
    ...(u.costUsd !== undefined
      ? { costUsd: u.costUsd, costSemantic: "delta" as const }
      : {}),
  };
}

function extractAssistantText(message: unknown): string {
  const m = message as { type?: string; content?: string; text?: string };
  if (m?.type === "assistant" && typeof m.content === "string") return m.content;
  if (m?.type === "assistant" && typeof m.text === "string") return m.text;
  return "";
}

function stripDir<T extends { dir?: string }>(opts: T): Omit<T, "dir"> {
  const { dir: _dir, ...rest } = opts;
  return rest;
}

/**
 * Strip both `dir` and the flat `temperature` shortcut before spreading
 * into gitclaw's QueryOptions. `temperature` is folded into `constraints`
 * by the engine; if it leaks through as a flat field gitclaw ignores it
 * but it's noisy in the typed options. See Wedge 1.7.
 */
function stripDirAndFlatTemperature<T extends { dir?: string; temperature?: number }>(
  opts: T,
): Omit<T, "dir" | "temperature"> {
  const { dir: _dir, temperature: _temp, ...rest } = opts;
  return rest;
}

/**
 * One-shot prompt iterable: yields a single user message then terminates.
 * Used by the per-turn `query()` loop so gitclaw consumes exactly one turn's
 * worth of input before its own iterator ends.
 */
async function* singleMessageIterable(text: string): AsyncIterable<GCUserMessage> {
  yield { type: "user", content: text };
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

function signalToController(signal: AbortSignal): AbortController {
  const ctrl = new AbortController();
  if (signal.aborted) ctrl.abort();
  else signal.addEventListener("abort", () => ctrl.abort(), { once: true });
  return ctrl;
}
