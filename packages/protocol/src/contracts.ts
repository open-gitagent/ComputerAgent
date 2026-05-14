import type { IdentitySource } from "./identity-source.js";
import type { UserMessage } from "./harness-rest.js";
import type { PermissionResult, SessionStore } from "./sdk-passthrough.js";

/**
 * Capabilities an engine declares at registration. Surfaced via `/v1/health`
 * and the first `ca_session_started` event so clients can avoid asking
 * the engine to do things it can't.
 */
export interface EngineCapabilities {
  /** Accepts new user messages mid-session via `POST /messages`. */
  readonly streamingInput: boolean;
  /** Emits token-level deltas as `sdk_message` events. */
  readonly partialMessages: boolean;
  /** Supports per-tool permission callbacks via `canUseTool`. */
  readonly permissionCallback: boolean;
  /** Supports session resume / fork. */
  readonly sessions: boolean;
  /** Honors a hard cost cap. */
  readonly budget: boolean;
}

/** Permission request handed from the engine to the harness server. */
export interface PermissionRequest {
  readonly callId: string;
  readonly toolName: string;
  readonly input: unknown;
}

/** Per-call context the harness server hands to the engine. */
export interface EngineContext<TOptions = unknown> {
  /** Stable session identifier — engines may use it to populate native message fields. */
  readonly sessionId: string;
  /** Engine-specific options the loader produced. */
  readonly options: TOptions;
  /** Working directory the agent runs in (already materialized). */
  readonly workdir: string;
  /** Environment variables to expose to the agent. */
  readonly envs: Readonly<Record<string, string>>;
  /** User messages in turn order. The engine reads this until it ends. */
  readonly userMessageQueue: AsyncIterable<UserMessage>;
  /** Engine calls this for permission gating; framework handles the round-trip. */
  readonly onPermissionRequest: (req: PermissionRequest) => Promise<PermissionResult>;
  /** Wired to `POST /cancel`; engine must observe and bail. */
  readonly abortSignal: AbortSignal;
  /** Optional hard cost cap. */
  readonly budget?: { readonly maxUsd?: number };
  /**
   * Optional pluggable session store. When set, the engine should use it for
   * conversation persistence — append turn entries, and on first turn check
   * for prior entries to resume from. Presence of the store IS the resume
   * signal; the engine decides based on what `load()` returns.
   */
  readonly sessionStore?: SessionStore;
}

/** Discriminated union of events an engine can emit. */
export type EngineEvent =
  | { readonly kind: "sdk_message"; readonly payload: unknown }
  | { readonly kind: "ca_usage_snapshot"; readonly inputTokens?: number; readonly outputTokens?: number; readonly costUsd?: number };

/**
 * EngineDriver — wraps an agent loop (Claude Agent SDK, Codex, gitclaw, …).
 *
 * Implementations are registered with `createHarnessServer({ engines: { ... } })`.
 * The harness server calls `startSession` once per session and consumes the returned
 * AsyncIterable until it completes or `abortSignal` fires.
 */
export interface EngineDriver<TOptions = unknown> {
  readonly name: string;
  readonly capabilities: EngineCapabilities;
  startSession(ctx: EngineContext<TOptions>): AsyncIterable<EngineEvent>;
}

/** Result of an `IdentityLoader.load()` call. */
export interface IdentityLoadResult<TOptions = unknown> {
  /** Engine-native options ready to feed into `EngineDriver.startSession`. */
  readonly options: TOptions;
  /** Identifying metadata, surfaced in `ca_session_started`. */
  readonly metadata: {
    readonly name: string;
    readonly version: string;
    readonly sha?: string;
  };
  /**
   * Optional post-merge hardening hook. Applied AFTER caller-supplied options
   * are merged on top of `options`. Use this to enforce identity-level
   * constraints that must override caller choices — e.g. a GAP manifest with
   * `compliance.supervision.human_in_the_loop: always` should reject any
   * caller attempt to set `permissionMode: bypassPermissions`. The "strictest
   * wins" rule lives here.
   */
  readonly harden?: (merged: TOptions) => TOptions;
  /** Optional cleanup; called when the session ends. */
  readonly cleanup?: () => Promise<void>;
}

/**
 * IdentityLoader — translates a "what is this agent" source into engine-native options.
 *
 * One loader, many per-engine adapters internally — the same `gitagentprotocol` loader can
 * target Claude Agent SDK, Codex, gitclaw, etc.
 */
export interface IdentityLoader<TOptions = unknown> {
  readonly name: string;
  load(args: {
    readonly source: IdentitySource;
    readonly targetEngine: string;
    readonly workdir: string;
  }): Promise<IdentityLoadResult<TOptions>>;
}
