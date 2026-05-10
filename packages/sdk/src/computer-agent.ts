import type {
  CreateSessionResponse,
  IdentitySource,
  UserMessage,
} from "@computeragent/protocol";
import { ChatHandle } from "./chat-handle.js";
import { consumeSseEvents } from "./sse-client.js";
import type { ChatInput, ComputerAgentOptions, PermissionDecision, ToolCallContext } from "./types.js";

const DEFAULT_HARNESS_URL = "http://127.0.0.1:7700";
const DEFAULT_LOADER = "gitagentprotocol";

/**
 * The user-facing client for the Harness Protocol.
 *
 *   const agent = new ComputerAgent({ source, harness, envs, options });
 *   const result = await agent.chat([{ role: "user", content: "hello" }]);
 *
 * Constructor configures the agent (identity, engine, runtime, policy).
 * `.chat(input)` invokes a turn. Multiple `.chat()` calls share a session.
 */
export class ComputerAgent {
  private readonly source: IdentitySource;
  private readonly harnessUrl: string;
  private readonly fetchImpl: typeof fetch;
  private existingSessionId: string | undefined;

  constructor(private readonly opts: ComputerAgentOptions) {
    this.source = normalizeSource(opts.source);
    this.harnessUrl = opts.harnessUrl ?? DEFAULT_HARNESS_URL;
    this.fetchImpl = opts.fetch ?? fetch;
    if (opts.sessionId) this.existingSessionId = opts.sessionId;
  }

  /** Stable session id. Available only after the first `.chat()` (or if explicitly passed). */
  get sessionId(): string | undefined {
    return this.existingSessionId;
  }

  /** Run a turn. See README and ChatHandle for usage shapes. */
  chat(input: ChatInput): ChatHandle {
    const isFirst = this.existingSessionId === undefined;
    const isStreamingInput = isAsyncIterableInput(input);

    const sessionIdPromise = isFirst
      ? this.createSession(toMessageArray(input), isStreamingInput)
      : Promise.resolve(this.existingSessionId!);

    if (!isFirst || isStreamingInput) {
      // Push messages over time (and call /end-input when the iterator finishes
      // for streaming-input). For subsequent turns we always push regardless.
      void sessionIdPromise.then(async (sid) => {
        await this.pushMessages(sid, input);
        if (isStreamingInput) await this.postEndInput(sid);
      });
    }

    const events = this.openEventStream(sessionIdPromise);
    const onPerm = this.opts.onToolCall ? this.wrapOnToolCall(this.opts.onToolCall) : undefined;

    return new ChatHandle({
      sessionIdPromise,
      events,
      harnessUrl: this.harnessUrl,
      fetchImpl: this.fetchImpl,
      onPermissionRequest: onPerm,
    });
  }

  // ── private ─────────────────────────────────────────────────────────────

  private async createSession(initialMessages: UserMessage[], streamingInput: boolean): Promise<string> {
    const body: Record<string, unknown> = {
      engine: this.opts.harness,
      identity: {
        loader: this.opts.identityLoader ?? DEFAULT_LOADER,
        source: this.source,
      },
    };
    if (this.opts.envs) body.envs = this.opts.envs;
    if (initialMessages.length > 0) body.messages = initialMessages;
    if (this.opts.options) body.options = this.opts.options;
    if (this.opts.sessionId) body.sessionId = this.opts.sessionId;
    if (streamingInput) body.streamingInput = true;

    const res = await this.fetchImpl(`${this.harnessUrl}/v1/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`POST /v1/sessions failed: ${res.status} ${await res.text()}`);
    const created = (await res.json()) as CreateSessionResponse;
    this.existingSessionId = created.sessionId;
    return created.sessionId;
  }

  private async postEndInput(sessionId: string): Promise<void> {
    await this.fetchImpl(`${this.harnessUrl}/v1/sessions/${sessionId}/end-input`, {
      method: "POST",
    });
  }

  private async pushMessages(sessionId: string, input: ChatInput): Promise<void> {
    const messages = toMessageArray(input);
    if (typeof input === "object" && Symbol.asyncIterator in input) {
      for await (const m of input as AsyncIterable<UserMessage>) {
        await this.postOneMessage(sessionId, m);
      }
      return;
    }
    for (const m of messages) await this.postOneMessage(sessionId, m);
  }

  private async postOneMessage(sessionId: string, message: UserMessage): Promise<void> {
    const res = await this.fetchImpl(`${this.harnessUrl}/v1/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    });
    if (!res.ok) {
      throw new Error(`POST /messages failed: ${res.status} ${await res.text()}`);
    }
  }

  private openEventStream(sessionPromise: Promise<string>) {
    const fetchImpl = this.fetchImpl;
    const harnessUrl = this.harnessUrl;
    return (async function* () {
      const sid = await sessionPromise;
      const res = await fetchImpl(`${harnessUrl}/v1/sessions/${sid}/events`, {
        headers: { Accept: "text/event-stream" },
      });
      if (!res.ok || !res.body) {
        throw new Error(`GET /events failed: ${res.status}`);
      }
      yield* consumeSseEvents(res.body);
    })();
  }

  private wrapOnToolCall(cb: (c: ToolCallContext) => Promise<PermissionDecision> | PermissionDecision) {
    return async (callId: string, toolName: string, input: unknown): Promise<PermissionDecision> => {
      return cb({ callId, toolName, input });
    };
  }
}

function normalizeSource(input: IdentitySource | string): IdentitySource {
  if (typeof input !== "string") return input;
  if (input.startsWith("/") || input.startsWith("./") || input.startsWith("../")) {
    return { type: "local", path: input };
  }
  return { type: "git", url: input };
}

function toMessageArray(input: ChatInput): UserMessage[] {
  if (typeof input === "string") return [{ role: "user", content: input }];
  if (Array.isArray(input)) return input;
  if (isAsyncIterableInput(input)) {
    // streaming-input: caller pushes messages over time; createSession sends none initially.
    return [];
  }
  return [input as UserMessage];
}

function isAsyncIterableInput(input: ChatInput): input is AsyncIterable<UserMessage> {
  return (
    typeof input === "object" &&
    input !== null &&
    Symbol.asyncIterator in (input as object)
  );
}
