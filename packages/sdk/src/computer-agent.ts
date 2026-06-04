import type {
  CreateSessionResponse,
  FsTreeEntry,
  FsTreeResponse,
  HarnessEvent,
  IdentitySource,
  Logger,
  UserMessage,
} from "@open-gitagent/protocol";
import { createLogger, nopLogger } from "@open-gitagent/protocol";
import { ChatHandle } from "./chat-handle.js";
import { asHarnessError } from "./errors.js";
import { consumeSseEvents } from "./sse-client.js";
import type { Substrate, BootedHarness } from "./substrate.js";
import type { AgentTelemetry } from "./telemetry.js";
import type {
  ChatInput,
  ChatResult,
  ComputerAgentOptions,
  PermissionDecision,
  ToolCallContext,
} from "./types.js";

const DEFAULT_HARNESS_URL = "http://127.0.0.1:7700";
const DEFAULT_LOADER = "gitagentprotocol";

/** Run a telemetry callback fire-and-forget — never let telemetry break a chat. */
function safeFireTelemetry(fn: (() => void | Promise<void>) | undefined): void {
  if (!fn) return;
  try {
    const r = fn();
    if (r && typeof (r as Promise<unknown>).then === "function") {
      (r as Promise<unknown>).catch(() => {});
    }
  } catch {
    /* swallow — telemetry must never break an agent run */
  }
}

/** Best-effort extract user message text from a ChatInput for the telemetry hook. */
function extractMessageText(input: ChatInput): string {
  if (typeof input === "string") return input;
  if (Array.isArray(input)) {
    const first = input.find((m) => m && typeof m === "object");
    if (first && typeof (first as { content?: unknown }).content === "string") {
      return (first as { content: string }).content;
    }
    return JSON.stringify(input).slice(0, 500);
  }
  return JSON.stringify(input).slice(0, 500);
}

/** Best-effort extract final assistant text from a ChatResult for the telemetry hook. */
function extractReplyText(result: ChatResult): string | undefined {
  for (let i = result.messages.length - 1; i >= 0; i--) {
    const m = result.messages[i] as Record<string, unknown> | undefined;
    if (!m || typeof m !== "object") continue;
    if (typeof m.content === "string") return m.content;
    if (typeof (m as { text?: unknown }).text === "string") return (m as { text: string }).text;
  }
  return undefined;
}

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
  /**
   * Effective envs after folding in `baseUrl` (injected as ANTHROPIC_BASE_URL
   * if the caller didn't already set that key explicitly). Computed once at
   * construction so the substrate boot and every createSession() see the same
   * env set. See Wedge 1.7.
   */
  private readonly effectiveEnvs: Readonly<Record<string, string>>;
  /**
   * Effective engine options after folding in the `model` and `temperature`
   * shortcuts. Computed once at construction so all chats see the same
   * options. Constructor shortcuts win over `opts.options` if both set
   * (the typed field is the high-level lever).
   */
  private readonly effectiveOptions: Readonly<Record<string, unknown>> | undefined;
  /**
   * Client-side logger. nopLogger when `debug` is off; pretty-print to stderr
   * when `debug: true`. Used to surface a 1-line summary per HarnessEvent the
   * agent consumes — the harness's own structured logs (engine.tool_use,
   * session.start, etc.) come from the substrate stderr relay.
   */
  private readonly logger: Logger;

  constructor(private readonly opts: ComputerAgentOptions) {
    this.source = normalizeSource(opts.source);
    this.staticHarnessUrl = opts.harnessUrl ?? DEFAULT_HARNESS_URL;
    this.substrate = isSubstrate(opts.runtime) ? opts.runtime : null;
    this.fetchImpl = opts.fetch ?? fetch;
    if (opts.sessionId) this.existingSessionId = opts.sessionId;

    // ── Validate + bake baseUrl into envs ───────────────────────────────────
    // Parse via `new URL(...)` to fail fast on syntactic garbage. Network
    // reachability is verified at first API call; we just want to catch
    // typos like "https//proxy.example" before they cause a confusing fetch.
    if (opts.baseUrl !== undefined) {
      try {
        new URL(opts.baseUrl);
      } catch {
        throw new Error(
          `ComputerAgent: invalid baseUrl ${JSON.stringify(opts.baseUrl)} — must be a valid URL (e.g. "https://api.anthropic.com").`,
        );
      }
    }
    const baseEnvs = opts.envs ?? {};
    let envs: Record<string, string> = { ...baseEnvs };
    if (opts.baseUrl && envs.ANTHROPIC_BASE_URL === undefined) {
      envs.ANTHROPIC_BASE_URL = opts.baseUrl;
    }
    // debug: surface every step in the spawned harness by defaulting
    // COMPUTERAGENT_LOG=debug + a pretty format. Caller's explicit value wins.
    if (opts.debug) {
      if (envs.COMPUTERAGENT_LOG === undefined) envs.COMPUTERAGENT_LOG = "debug";
      if (envs.COMPUTERAGENT_LOG_FORMAT === undefined) envs.COMPUTERAGENT_LOG_FORMAT = "pretty";
    }
    this.effectiveEnvs = envs;

    // Client-side logger — separate from the harness's. Prints one line per
    // HarnessEvent consumed by ChatHandle. Use a fixed pretty level for debug,
    // honor env otherwise. Off by default.
    this.logger = opts.debug
      ? createLogger({ component: "client", level: "info", format: "pretty" })
      : nopLogger;

    // ── Bake model + temperature shortcuts into options ─────────────────────
    const baseOptions = opts.options ?? {};
    const overrides: Record<string, unknown> = {};
    if (opts.model !== undefined) overrides.model = opts.model;
    if (opts.temperature !== undefined) overrides.temperature = opts.temperature;
    const hasOverrides = Object.keys(overrides).length > 0;
    const hasBase = Object.keys(baseOptions).length > 0;
    if (hasOverrides || hasBase) {
      this.effectiveOptions = hasOverrides ? { ...baseOptions, ...overrides } : baseOptions;
    } else {
      this.effectiveOptions = undefined;
    }

    // ── Fire telemetry: this agent now exists. ────────────────────────────
    // The Mongo telemetry impl upserts a doc into `agent_registry` so the
    // AgentOS dashboard shows the agent immediately, even in library-mode
    // deployments where the SDK is just an npm dep inside the customer's
    // worker. Fire-and-forget; telemetry exceptions never propagate.
    this.telemetry = opts.telemetry;
    if (this.telemetry?.onAgentConstructed) {
      safeFireTelemetry(() =>
        this.telemetry!.onAgentConstructed!({
          source: this.source,
          harness: opts.harness,
          model: opts.model,
          baseUrl: opts.baseUrl,
        }),
      );
    }
  }

  private readonly telemetry: AgentTelemetry | undefined;

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
    // Release telemetry resources (e.g. close a Mongo client). Fire-and-forget.
    if (this.telemetry?.onClose) safeFireTelemetry(() => this.telemetry!.onClose!());
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
   * Fetch a file from the agent's workdir as raw bytes (issue #1).
   *
   *   const bytes = await agent.fetchArtifact("deck.pptx");
   *   if (bytes) await Bun.write("local-deck.pptx", bytes);
   *
   * Returns `null` if the file doesn't exist (404). Throws for other harness
   * errors. Path is relative to the session workdir — the harness jails it.
   *
   * Use for binary outputs an agent produced via its Write/Bash tools:
   * `.pptx`, `.pdf`, `.xlsx`, `.zip`, `.png`, anything. For text use
   * `fetchArtifactText()` — same call, returns a string.
   */
  async fetchArtifact(path: string): Promise<Uint8Array | null> {
    const url = await this.requireSessionFileUrl(path);
    const res = await this.fetchImpl(url);
    if (res.status === 404) return null;
    if (!res.ok) throw await asHarnessError(res);
    const buf = await res.arrayBuffer();
    return new Uint8Array(buf);
  }

  /**
   * Fetch a file from the agent's workdir as UTF-8 text. Returns `null` if
   * the file doesn't exist. Throws for other harness errors.
   */
  async fetchArtifactText(path: string): Promise<string | null> {
    const url = await this.requireSessionFileUrl(path);
    const res = await this.fetchImpl(url);
    if (res.status === 404) return null;
    if (!res.ok) throw await asHarnessError(res);
    return await res.text();
  }

  /**
   * List the agent's workdir as a flat array of entries (files + dirs).
   * Default depth is 1; pass `depth: 10` for a near-full tree. The harness
   * jails paths to the workdir root.
   *
   * Useful for "what did the agent produce?" exploration before fetching
   * specific files via `fetchArtifact()`.
   */
  async listWorkdir(opts: { path?: string; depth?: number } = {}): Promise<readonly FsTreeEntry[]> {
    const sid = this.requireSessionId();
    const harnessUrl = await this.resolveHarnessUrl();
    const params = new URLSearchParams();
    if (opts.path !== undefined) params.set("path", opts.path);
    if (opts.depth !== undefined) params.set("depth", String(opts.depth));
    const qs = params.toString();
    const res = await this.fetchImpl(
      `${harnessUrl}/v1/sessions/${sid}/fs/tree${qs ? `?${qs}` : ""}`,
    );
    if (!res.ok) throw await asHarnessError(res);
    const body = (await res.json()) as FsTreeResponse;
    return body.entries;
  }

  /**
   * Ensure the harness session exists WITHOUT pushing a user message or running
   * a turn. Boots the substrate (if needed) and creates the session, so callers
   * can write files into the workdir (see `writeArtifact`) before the first
   * `chat()`. Idempotent — returns the existing session id on repeat calls, and
   * a subsequent `chat()` reuses the same session rather than creating a new one.
   */
  async ensureSession(): Promise<string> {
    // Gate on hasRegisteredOnServer, NOT existingSessionId: a constructor-supplied
    // sessionId pre-sets existingSessionId before the harness session actually
    // exists, so checking existingSessionId here would skip creation and leave the
    // harness without the session. This mirrors chat()'s isFirstOnServer logic.
    if (this.hasRegisteredOnServer) return this.existingSessionId!;
    this.hasRegisteredOnServer = true;
    return this.createSession(this.resolveHarnessUrl());
  }

  /**
   * Write a file into the session workdir via the harness `PUT /fs/file`.
   * Accepts raw bytes (binary-safe — e.g. an uploaded PDF) or a UTF-8 string.
   * Requires a session — call `ensureSession()` (or `chat()`) first.
   */
  async writeArtifact(path: string, content: Uint8Array | string): Promise<void> {
    const url = await this.requireSessionFileUrl(path);
    const src = typeof content === "string" ? new TextEncoder().encode(content) : content;
    // Copy into a plain ArrayBuffer (a clean BodyInit) — avoids TS 5.7's generic
    // Uint8Array<ArrayBufferLike> mismatch and stays binary-safe.
    const ab = new ArrayBuffer(src.byteLength);
    new Uint8Array(ab).set(src);
    const res = await this.fetchImpl(url, { method: "PUT", body: ab });
    if (!res.ok) throw await asHarnessError(res);
  }

  private requireSessionId(): string {
    if (!this.existingSessionId) {
      throw new Error(
        "ComputerAgent: no session yet — call `chat()` (and let it start) before fetching artifacts or listing the workdir.",
      );
    }
    return this.existingSessionId;
  }

  private async requireSessionFileUrl(path: string): Promise<string> {
    const sid = this.requireSessionId();
    const harnessUrl = await this.resolveHarnessUrl();
    return `${harnessUrl}/v1/sessions/${sid}/fs/file?path=${encodeURIComponent(path)}`;
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

    const handle = new ChatHandle({
      sessionIdPromise,
      events,
      harnessUrlPromise,
      fetchImpl: this.fetchImpl,
      onPermissionRequest: onPerm,
      logger: this.logger,
    });

    // ── Telemetry: fire onChatStart now, attach onChatEnd to the result ──
    // ChatHandle.then() is memoized via result() — so attaching our own
    // .then alongside the caller's await is safe; both consumers see the
    // same resolved value. Fire-and-forget; never break the chat.
    if (this.telemetry) {
      const t0 = Date.now();
      let ctx: unknown = undefined;
      if (this.telemetry.onChatStart) {
        try {
          ctx = this.telemetry.onChatStart({
            sessionIdPromise,
            message: extractMessageText(input),
          });
        } catch {
          /* swallow */
        }
      }
      if (this.telemetry.onChatEnd) {
        const tel = this.telemetry;
        Promise.resolve(handle as PromiseLike<ChatResult>).then(
          (result) => {
            safeFireTelemetry(() =>
              tel.onChatEnd!({
                context: ctx,
                sessionId: result.sessionId,
                ok: true,
                durationMs: Date.now() - t0,
                usage: {
                  inputTokens: result.usage.inputTokens,
                  outputTokens: result.usage.outputTokens,
                  costUsd: result.usage.costUsd,
                },
                reply: extractReplyText(result),
              }),
            );
          },
          (err: unknown) => {
            safeFireTelemetry(() =>
              tel.onChatEnd!({
                context: ctx,
                sessionId: this.existingSessionId ?? "",
                ok: false,
                error: err instanceof Error ? err.message : String(err),
                durationMs: Date.now() - t0,
              }),
            );
          },
        );
      }
    }

    return handle;
  }

  // ── private ─────────────────────────────────────────────────────────────

  /** Resolve the harness URL — boots the substrate on first call (lazy + memoized). */
  private resolveHarnessUrl(): Promise<string> {
    if (!this.substrate) return Promise.resolve(this.staticHarnessUrl);
    if (this.booted) return Promise.resolve(this.booted.baseUrl);
    if (!this.bootingPromise) {
      this.bootingPromise = this.substrate
        .bootHarness({ envs: this.effectiveEnvs })
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
    if (Object.keys(this.effectiveEnvs).length > 0) body.envs = this.effectiveEnvs;
    if (this.effectiveOptions) body.options = this.effectiveOptions;
    if (this.opts.sessionId) body.sessionId = this.opts.sessionId;
    if (this.opts.sessionStore) body.sessionStore = this.opts.sessionStore;
    if (this.opts.attachments && this.opts.attachments.length > 0) {
      body.attachments = this.opts.attachments;
    }
    // Forward per-tool-call policy config so the harness builds its decider
    // (SrsPolicyDecider). Without this the harness never gates tool calls.
    if (this.opts.policy) body.policy = this.opts.policy;

    const res = await this.fetchImpl(`${harnessUrl}/v1/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      // Surface typed errors when the harness rejected a known field — engine
      // name, loader name, or store kind. Catchable via UnknownEngineError /
      // UnknownLoaderError / UnknownStoreError; falls back to HarnessProtocolError
      // for other coded errors or generic Error for non-JSON bodies.
      throw await asHarnessError(res, {
        engine: this.opts.harness,
        loader: this.opts.identityLoader ?? DEFAULT_LOADER,
        storeKind: this.opts.sessionStore?.kind,
      });
    }
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
    return async (
      callId: string,
      toolName: string,
      input: unknown,
      risk?: "low" | "medium" | "high" | "destructive",
    ): Promise<PermissionDecision> => {
      return cb({ callId, toolName, input, ...(risk !== undefined ? { risk } : {}) });
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
 * Recognises every shipped engine's NATURAL terminator message:
 *
 *   - Claude Agent SDK:   `{ type: "result", ... }`     — SDKResultMessage
 *   - gitclaw (gitagent): `{ type: "system", subtype: "session_end", ... }`
 *
 * Both are real messages the underlying engine emits at the end of a turn —
 * not synthetic markers injected by us. The SDK looks for either, so an
 * `agent.chat()` handle terminates as soon as whichever engine is in play
 * signals its own turn is over.
 *
 * Future engines (Codex, OpenCode, Gemini-CLI, ...) plug in by extending
 * this matcher with their native terminator shape. No protocol change needed.
 */
function isTurnResultEvent(event: HarnessEvent): boolean {
  if (event.kind !== "sdk_message") return false;
  const payload = event.payload as { type?: string; subtype?: string } | null | undefined;
  if (payload?.type === "result") return true;
  if (payload?.type === "system" && payload?.subtype === "session_end") return true;
  return false;
}
