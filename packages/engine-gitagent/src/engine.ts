import { query, type GCUserMessage, type QueryOptions } from "gitclaw";
import type {
  EngineCapabilities,
  EngineContext,
  EngineDriver,
  EngineEvent,
  UserMessage,
} from "@computeragent/protocol";
import { buildPreToolUse } from "./permission-bridge.js";
import {
  appendAssistantTurn,
  appendUserTurn,
  PROJECT_KEY,
  renderPriorContext,
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
 * Owns:
 *   - Adapting our streaming-input queue (UserMessage[]) to gitclaw's
 *     AsyncIterable<GCUserMessage>.
 *   - Forwarding every GCMessage as `EngineEvent { kind: "sdk_message" }`
 *     verbatim — the harness server emits these as SSE `event: sdk_message`.
 *   - Wiring `preToolUse` to the framework's permission round-trip.
 *
 * Does NOT own:
 *   - GAP → gitclaw options translation (that's identity-gitagentprotocol's adapter).
 *   - Env injection (single-tenant for now: caller sets process.env before boot;
 *     multi-tenant isolation is a Wedge 1.5+ concern handled by substrates).
 */
export class GitAgentEngine implements EngineDriver<GitclawForwardOptions & { dir?: string }> {
  readonly name = "gitagent";
  readonly capabilities = CAPABILITIES;

  async *startSession(
    ctx: EngineContext<GitclawForwardOptions & { dir?: string }>,
  ): AsyncIterable<EngineEvent> {
    // SessionStore replay: gitclaw has no native sessionStore parameter, so
    // when one is configured we synthesize resume by loading prior turns and
    // injecting them via systemPromptSuffix, then writing each new exchange
    // back. See ./session-replay.ts.
    const storeKey = { projectKey: PROJECT_KEY, sessionId: ctx.sessionId };
    const priorSuffix = ctx.sessionStore
      ? renderPriorContext((await ctx.sessionStore.load(storeKey)) ?? [])
      : null;
    const ordinalStart = priorSuffix ? countPriorTurns(priorSuffix) : 0;

    // Track user messages so we can persist them after capture; this also
    // adapts our queue to gitclaw's GCUserMessage shape.
    const capturedUserMessages: string[] = [];
    const prompt = adaptUserMessages(ctx.userMessageQueue, capturedUserMessages);

    const abortController = signalToController(ctx.abortSignal);

    const baseSuffix = ctx.options.systemPromptSuffix ?? "";
    const systemPromptSuffix = priorSuffix
      ? (baseSuffix ? `${baseSuffix}\n\n${priorSuffix}` : priorSuffix)
      : (baseSuffix || undefined);

    const options: QueryOptions = {
      prompt,
      dir: ctx.options.dir ?? ctx.workdir,
      sessionId: ctx.sessionId,
      abortController,
      hooks: { preToolUse: buildPreToolUse(ctx.onPermissionRequest) },
      ...stripDir(ctx.options),
      ...(systemPromptSuffix ? { systemPromptSuffix } : {}),
    };

    let assistantOrdinal = ordinalStart;
    for await (const message of query(options)) {
      if (ctx.abortSignal.aborted) break;
      yield { kind: "sdk_message", payload: message };
      if (ctx.sessionStore) {
        const text = extractAssistantText(message);
        if (text) {
          assistantOrdinal += 1;
          await appendAssistantTurn(ctx.sessionStore, ctx.sessionId, text, assistantOrdinal);
        }
      }
    }

    // Persist user messages now that the turn has finished. We do this at the
    // end (rather than per-message) so a turn cancelled mid-flight doesn't
    // half-persist; user messages are durable iff the turn produced output.
    if (ctx.sessionStore && capturedUserMessages.length > 0) {
      let userOrdinal = ordinalStart;
      for (const text of capturedUserMessages) {
        userOrdinal += 1;
        await appendUserTurn(ctx.sessionStore, ctx.sessionId, text, userOrdinal);
      }
    }
  }
}

function countPriorTurns(rendered: string): number {
  // Used to derive a stable ordinal for new turn entries so uuids don't
  // collide with prior content. Cheap line-count proxy is good enough.
  return (rendered.match(/^(user|assistant):/gm) ?? []).length;
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
 * Bridge our UserMessage queue to gitclaw's GCUserMessage AsyncIterable.
 * When `captured` is supplied, each forwarded message is also recorded so
 * the engine can persist it to the SessionStore after the turn completes.
 */
async function* adaptUserMessages(
  queue: AsyncIterable<UserMessage>,
  captured?: string[],
): AsyncIterable<GCUserMessage> {
  for await (const m of queue) {
    const text = flattenContent(m.content);
    captured?.push(text);
    yield { type: "user", content: text };
  }
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
