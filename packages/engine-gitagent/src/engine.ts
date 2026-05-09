import { query, type GCUserMessage, type QueryOptions } from "gitclaw";
import type {
  EngineCapabilities,
  EngineContext,
  EngineDriver,
  EngineEvent,
  UserMessage,
} from "@computeragent/protocol";
import { buildPreToolUse } from "./permission-bridge.js";

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
    const prompt = adaptUserMessages(ctx.userMessageQueue);
    const abortController = signalToController(ctx.abortSignal);

    const options: QueryOptions = {
      prompt,
      dir: ctx.options.dir ?? ctx.workdir,
      sessionId: ctx.sessionId,
      abortController,
      hooks: { preToolUse: buildPreToolUse(ctx.onPermissionRequest) },
      ...stripDir(ctx.options),
    };

    for await (const message of query(options)) {
      if (ctx.abortSignal.aborted) break;
      yield { kind: "sdk_message", payload: message };
    }
  }
}

function stripDir<T extends { dir?: string }>(opts: T): Omit<T, "dir"> {
  const { dir: _dir, ...rest } = opts;
  return rest;
}

/** Bridge our UserMessage queue to gitclaw's GCUserMessage AsyncIterable. */
async function* adaptUserMessages(
  queue: AsyncIterable<UserMessage>,
): AsyncIterable<GCUserMessage> {
  for await (const m of queue) {
    yield { type: "user", content: flattenContent(m.content) };
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
