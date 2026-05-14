import { query, type GCUserMessage, type QueryOptions } from "gitclaw";
import type {
  EngineCapabilities,
  EngineContext,
  EngineDriver,
  EngineEvent,
  SessionStore,
  UserMessage,
} from "@computeragent/protocol";
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
    // back. See ./session-replay.ts. A single TurnIndexer is shared between
    // user and assistant persistence so the document on disk sorts by
    // turnIndex into true conversation order regardless of write interleaving.
    const store = ctx.sessionStore;
    const storeKey = { projectKey: PROJECT_KEY, sessionId: ctx.sessionId };
    const prior = store ? (await store.load(storeKey)) ?? [] : [];
    const priorSuffix = renderPriorContext(prior);
    const indexer = new TurnIndexer(nextTurnIndex(prior));

    const abortController = signalToController(ctx.abortSignal);

    const baseSuffix = ctx.options.systemPromptSuffix ?? "";
    const systemPromptSuffix = priorSuffix
      ? (baseSuffix ? `${baseSuffix}\n\n${priorSuffix}` : priorSuffix)
      : (baseSuffix || undefined);

    // Adapter that persists each user message BEFORE forwarding to gitclaw,
    // so the document records the message in turn-correct order even if the
    // turn errors out partway through (the prior assistant→user ordering
    // problem in v1 of this code).
    const prompt = adaptAndPersistUserMessages(
      ctx.userMessageQueue,
      ctx.sessionId,
      store,
      indexer,
    );

    const options: QueryOptions = {
      prompt,
      dir: ctx.options.dir ?? ctx.workdir,
      sessionId: ctx.sessionId,
      abortController,
      hooks: { preToolUse: buildPreToolUse(ctx.onPermissionRequest) },
      ...stripDir(ctx.options),
      ...(systemPromptSuffix ? { systemPromptSuffix } : {}),
    };

    for await (const message of query(options)) {
      if (ctx.abortSignal.aborted) break;
      yield { kind: "sdk_message", payload: message };
      if (store) {
        const text = extractAssistantText(message);
        if (text) {
          await appendAssistantTurn(store, ctx.sessionId, text, indexer.next());
        }
      }
    }
  }
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
 * When a SessionStore is configured, each user message is persisted before
 * being forwarded to gitclaw — so the document records turns in true
 * conversation order even if the turn errors out partway through.
 */
async function* adaptAndPersistUserMessages(
  queue: AsyncIterable<UserMessage>,
  sessionId: string,
  store: SessionStore | undefined,
  indexer: TurnIndexer,
): AsyncIterable<GCUserMessage> {
  for await (const m of queue) {
    const text = flattenContent(m.content);
    if (store) {
      await appendUserTurn(store, sessionId, text, indexer.next());
    }
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
