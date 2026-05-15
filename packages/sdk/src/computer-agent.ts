import type {
  CreateSessionResponse,
  HarnessEvent,
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
  /**
   * True once this instance has POSTed to /v1/sessions. Distinct from
   * `existingSessionId !== undefined`: a constructor-supplied sessionId
   * still needs an initial /v1/sessions POST so the server registers a
   * Session entry for it (and the engine receives any sessionStore config).
   * After the first chat(), subsequent chats reuse the same session via
   * /v1/sessions/:id/messages within this instance.
   */
  private hasRegisteredOnServer = false;
  /**
   * Highest SSE event id observed across all chats on this agent.
   * Sent as `Last-Event-ID` on every subsequent /events open so the harness
   * skips already-replayed events for the new chat handle. -1 means "fresh."
   * Critical for multi-turn correctness — see issue #2.
   */
  private lastSeenEventId = -1;

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

  /**
   * Tear down any substrate this agent booted. Idempotent.
   *
   * Best-effort: POSTs /end-input first so the harness's user-message queue
   * closes cleanly and the engine drains. Failures (network, already-dead
   * harness) are swallowed — substrate shutdown still happens.
   */
  async dispose(): Promise<void> {
    if (this.hasRegisteredOnServer && this.existingSessionId && this.booted) {
      try {
        const harnessUrl = this.booted.baseUrl;
        await this.fetchImpl(`${harnessUrl}/v1/sessions/${this.existingSessionId}/end-input`, {
          method: "POST",
        });
      } catch {
        /* harness already gone; substrate.shutdown() will clean up regardless */
      }
    }
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

  /**
   * Run a turn. See ChatHandle for usage shapes.
   *
   * Multi-turn shape: sessions are always created in streaming-input mode
   * internally so the engine stays alive between chats. Each `chat()` push
   * messages via /messages (never via the createSession body) and opens
   * a fresh /events stream with `Last-Event-ID` set to the highest event
   * seen so far — so the new handle sees only events from this turn forward.
   * The handle's iterable terminates on the turn's `result` SDK message
   * (synthesizing a `ca_session_ended` for ChatHandle.drain) OR on a real
   * server-emitted `ca_session_ended` (cancel / error / dispose).
   */
  chat(input: ChatInput): ChatHandle {
    const isFirstOnServer = !this.hasRegisteredOnServer;
    this.hasRegisteredOnServer = true;
    const harnessUrlPromise = this.resolveHarnessUrl();

    const sessionIdPromise = isFirstOnServer
      ? this.createSession(harnessUrlPromise)
      : Promise.resolve(this.existingSessionId!);

    // Always push via /messages (every turn, including the first). The
    // createSession body never carries `messages` — the engine is configured
    // for streaming-input so the user-message queue is the source of truth.
    // Swallow the rejection: if createSession failed, the same error will
    // surface through the events fetch in openTurnEventStream → ChatHandle,
    // so the caller sees it once, not twice (and we avoid an unhandled rejection).
    void sessionIdPromise
      .then((sid) => this.pushMessages(sid, input, harnessUrlPromise))
      .catch(() => {});

    const events = this.openTurnEventStream(sessionIdPromise, harnessUrlPromise);
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

  private async createSession(harnessUrlPromise: Promise<string>): Promise<string> {
    const harnessUrl = await harnessUrlPromise;
    // Always streaming-input — the engine must stay alive across chats so
    // turn 2's user message has a consumer. /end-input is sent on dispose().
    const body: Record<string, unknown> = {
      engine: this.opts.harness,
      identity: {
        loader: this.opts.identityLoader ?? DEFAULT_LOADER,
        source: this.source,
      },
      streamingInput: true,
    };
    if (this.opts.envs) body.envs = this.opts.envs;
    if (this.opts.options) body.options = this.opts.options;
    if (this.opts.sessionId) body.sessionId = this.opts.sessionId;
    if (this.opts.sessionStore) body.sessionStore = this.opts.sessionStore;

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

  /**
   * Open an SSE stream for a single turn.
   *
   * Critical for multi-turn correctness:
   *   - Sends `Last-Event-ID: <highest seen>` so the harness's replay buffer
   *     skips events the SDK already saw on prior chats. Without this, every
   *     new chat() would re-yield turn 1's events (issue #2).
   *   - Tracks the highest event id seen so the next chat() can resume past it.
   *   - Terminates the iterable when this turn finishes — either on a real
   *     server-emitted `ca_session_ended` (cancel/error/dispose) OR by
   *     synthesizing one when the turn's `result` SDK message arrives. The
   *     synthesized terminator lets `ChatHandle.drain()` resolve cleanly even
   *     though the underlying server session is still alive.
   */
  private openTurnEventStream(
    sessionPromise: Promise<string>,
    harnessUrlPromise: Promise<string>,
  ): AsyncIterable<HarnessEvent> {
    const fetchImpl = this.fetchImpl;
    const self = this;
    return (async function* () {
      const [sid, harnessUrl] = await Promise.all([sessionPromise, harnessUrlPromise]);
      const headers: Record<string, string> = { Accept: "text/event-stream" };
      if (self.lastSeenEventId >= 0) {
        headers["Last-Event-ID"] = String(self.lastSeenEventId);
      }
      const res = await fetchImpl(`${harnessUrl}/v1/sessions/${sid}/events`, { headers });
      if (!res.ok || !res.body) {
        throw new Error(`GET /events failed: ${res.status}`);
      }
      let yieldedTerminator = false;
      try {
        for await (const env of consumeSseEvents(res.body)) {
          if (typeof env.id === "number" && env.id > self.lastSeenEventId) {
            self.lastSeenEventId = env.id;
          }
          // Real session-end (cancel / error / dispose) — pass through and stop.
          if (env.event.kind === "ca_session_ended") {
            yieldedTerminator = true;
            yield env.event;
            return;
          }
          yield env.event;
          // Turn-end signal: the engine emitted its terminal `result` SDK
          // message. Synthesize a `ca_session_ended` so the ChatHandle's
          // drain loop resolves, then stop iterating. The underlying server
          // session stays alive for the next chat() call.
          if (isTurnResultEvent(env.event)) {
            yieldedTerminator = true;
            yield {
              kind: "ca_session_ended",
              sessionId: sid,
              reason: "complete",
            } satisfies HarnessEvent;
            return;
          }
        }
      } finally {
        try {
          await res.body?.cancel();
        } catch {
          /* already cancelled */
        }
      }
      // SSE closed before this turn's result. Synthesize a terminator so the
      // handle doesn't hang on drain().
      if (!yieldedTerminator) {
        yield {
          kind: "ca_session_ended",
          sessionId: sid,
          reason: "error",
          errorMessage: "SSE stream closed before turn completed",
        } satisfies HarnessEvent;
      }
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

/**
 * Does this event mark the end of a turn?
 *
 * Currently: an `sdk_message` whose payload type is `result`. This matches
 * the Claude Agent SDK's terminal `SDKResultMessage`. Other engines that
 * follow the same convention (one `result`-typed message per turn) get the
 * same behavior. Engines without a clear turn boundary in their event union
 * would need a different signal — but at v0.1 every shipped engine follows
 * the SDKResultMessage convention.
 */
function isTurnResultEvent(event: HarnessEvent): boolean {
  if (event.kind !== "sdk_message") return false;
  const payload = event.payload as { type?: string } | null | undefined;
  return payload?.type === "result";
}
