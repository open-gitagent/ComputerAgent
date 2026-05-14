import type {
  CreateSessionResponse,
  IdentitySource,
  UserMessage,
} from "@computeragent/protocol";
import { ChatHandle } from "./chat-handle.js";
import { consumeSseEvents } from "./sse-client.js";
import type { Substrate, BootedHarness } from "./substrate.js";
import type { ChatInput, ComputerAgentOptions, PermissionDecision, ToolCallContext } from "./types.js";

const DEFAULT_HARNESS_URL = "http://127.0.0.1:7700";
const DEFAULT_LOADER = "gitagentprotocol";

function isSubstrate(r: unknown): r is Substrate {
  return typeof r === "object" && r !== null && typeof (r as Substrate).bootHarness === "function";
}

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
  private readonly fetchImpl: typeof fetch;
  private readonly substrate: Substrate | null;
  private readonly staticHarnessUrl: string;
  private booted: BootedHarness | null = null;
  private bootingPromise: Promise<string> | null = null;
  private existingSessionId: string | undefined;

  constructor(private readonly opts: ComputerAgentOptions) {
    this.source = normalizeSource(opts.source);
    this.staticHarnessUrl = opts.harnessUrl ?? DEFAULT_HARNESS_URL;
    this.substrate = isSubstrate(opts.runtime) ? opts.runtime : null;
    this.fetchImpl = opts.fetch ?? fetch;
    if (opts.sessionId) this.existingSessionId = opts.sessionId;
  }

  /** Stable session id. Available only after the first `.chat()` (or if explicitly passed). */
  get sessionId(): string | undefined {
    return this.existingSessionId;
  }

  /** Tear down any substrate this agent booted. Idempotent. */
  async dispose(): Promise<void> {
    if (this.booted) {
      const b = this.booted;
      this.booted = null;
      this.bootingPromise = null;
      await b.shutdown();
    }
  }

  /**
   * Enables `await using agent = new ComputerAgent({...})` — TC39 explicit
   * resource management. The substrate (if any) is torn down automatically
   * when the agent goes out of scope.
   */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.dispose();
  }

  /**
   * Resolve the harness URL the agent talks to. Triggers substrate boot if
   * needed (lazy + memoized). Mainly useful for callers that want to call
   * `/v1/sessions/:id/fs/*` directly through the same URL.
   */
  harnessUrl(): Promise<string> {
    return this.resolveHarnessUrl();
  }

  /** Run a turn. See ChatHandle for usage shapes. */
  chat(input: ChatInput): ChatHandle {
    const isFirst = this.existingSessionId === undefined;
    const isStreamingInput = isAsyncIterableInput(input);
    const harnessUrlPromise = this.resolveHarnessUrl();

    const sessionIdPromise = isFirst
      ? this.createSession(toMessageArray(input), isStreamingInput, harnessUrlPromise)
      : Promise.resolve(this.existingSessionId!);

    if (!isFirst || isStreamingInput) {
      void sessionIdPromise.then(async (sid) => {
        await this.pushMessages(sid, input, harnessUrlPromise);
        if (isStreamingInput) await this.postEndInput(sid, harnessUrlPromise);
      });
    }

    const events = this.openEventStream(sessionIdPromise, harnessUrlPromise);
    const onPerm = this.opts.onToolCall ? this.wrapOnToolCall(this.opts.onToolCall) : undefined;

    return new ChatHandle({
      sessionIdPromise,
      events,
      harnessUrlPromise,
      fetchImpl: this.fetchImpl,
      onPermissionRequest: onPerm,
    });
  }

  // ── private ─────────────────────────────────────────────────────────────

  /** Resolve the harness URL — boots the substrate on first call (lazy + memoized). */
  private resolveHarnessUrl(): Promise<string> {
    if (!this.substrate) return Promise.resolve(this.staticHarnessUrl);
    if (this.booted) return Promise.resolve(this.booted.baseUrl);
    if (!this.bootingPromise) {
      this.bootingPromise = this.substrate
        .bootHarness({ envs: this.opts.envs ?? {} })
        .then((b) => {
          this.booted = b;
          return b.baseUrl;
        });
    }
    return this.bootingPromise;
  }

  private async createSession(
    initialMessages: UserMessage[],
    streamingInput: boolean,
    harnessUrlPromise: Promise<string>,
  ): Promise<string> {
    const harnessUrl = await harnessUrlPromise;
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

    const res = await this.fetchImpl(`${harnessUrl}/v1/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`POST /v1/sessions failed: ${res.status} ${await res.text()}`);
    const created = (await res.json()) as CreateSessionResponse;
    this.existingSessionId = created.sessionId;
    return created.sessionId;
  }

  private async postEndInput(sessionId: string, harnessUrlPromise: Promise<string>): Promise<void> {
    const harnessUrl = await harnessUrlPromise;
    await this.fetchImpl(`${harnessUrl}/v1/sessions/${sessionId}/end-input`, {
      method: "POST",
    });
  }

  private async pushMessages(sessionId: string, input: ChatInput, harnessUrlPromise: Promise<string>): Promise<void> {
    const harnessUrl = await harnessUrlPromise;
    if (isAsyncIterableInput(input)) {
      for await (const m of input) {
        await this.postOneMessage(sessionId, m, harnessUrl);
      }
      return;
    }
    const messages = toMessageArray(input);
    for (const m of messages) await this.postOneMessage(sessionId, m, harnessUrl);
  }

  private async postOneMessage(sessionId: string, message: UserMessage, harnessUrl: string): Promise<void> {
    const res = await this.fetchImpl(`${harnessUrl}/v1/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    });
    if (!res.ok) {
      throw new Error(`POST /messages failed: ${res.status} ${await res.text()}`);
    }
  }

  private openEventStream(sessionPromise: Promise<string>, harnessUrlPromise: Promise<string>) {
    const fetchImpl = this.fetchImpl;
    return (async function* () {
      const [sid, harnessUrl] = await Promise.all([sessionPromise, harnessUrlPromise]);
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
