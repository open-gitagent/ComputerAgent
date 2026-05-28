/**
 * `AgentTelemetry` — the hook the SDK calls so an external collector can
 * register the agent in a dashboard registry and record every chat turn.
 *
 * Designed for one concrete deployment shape: ComputerAgent runs as a
 * *library* inside the customer's existing worker (e.g. a Temporal worker
 * pod), not as a separate HTTP service. In that shape there's no central
 * server collecting traces — the SDK itself has to emit them. Pass an
 * `AgentTelemetry` and we'll fire these hooks from the lifecycle.
 *
 * The first-class implementation is `@open-gitagent/agent-registry-mongo`
 * which writes to the `agent_registry` and `agent_logs` Mongo collections
 * that AgentOS reads. Anything else (Honeycomb, OTel, Lyzr Trace, custom
 * HTTP push) is a small adapter on top of this interface.
 *
 * Contract:
 *  - All methods are optional. Implementations can subscribe to a subset.
 *  - All methods return `void | Promise<void>`. The SDK fires them
 *    fire-and-forget — exceptions are caught and logged at debug level
 *    but never propagate up. Telemetry must never break an agent run.
 *  - Hooks fire in order: `onAgentConstructed` once at construction,
 *    `onChatStart` + `onChatEnd` paired per chat() call, `onClose` once
 *    on `dispose()`.
 *  - `onChatStart` may return an opaque context that is passed back to
 *    `onChatEnd`. Useful for stashing per-chat timer state.
 */
import type { IdentitySource } from "@open-gitagent/protocol";

export interface AgentConstructedInfo {
  readonly source: IdentitySource;
  readonly harness: string;
  readonly model?: string;
  /** Best-effort effective base URL the agent will reach for the LLM. */
  readonly baseUrl?: string;
}

export interface ChatStartInfo {
  /** Resolves once the session is registered on the harness. */
  readonly sessionIdPromise: Promise<string>;
  /** User message text (or first message if a multi-part input). */
  readonly message: string;
}

export interface ChatEndInfo {
  /** Whatever `onChatStart` returned. The implementation defines the shape. */
  readonly context: unknown;
  readonly sessionId: string;
  readonly ok: boolean;
  readonly error?: string;
  readonly durationMs: number;
  readonly usage?: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly costUsd?: number;
  };
  /** Final assistant text, if extractable. Implementations may truncate. */
  readonly reply?: string;
}

export interface AgentTelemetry {
  /** Fires once when `new ComputerAgent(...)` is constructed. */
  onAgentConstructed?(info: AgentConstructedInfo): void | Promise<void>;

  /** Fires at the start of each `agent.chat(msg)` call. */
  onChatStart?(info: ChatStartInfo): unknown;

  /** Fires when a chat completes (success or failure). */
  onChatEnd?(info: ChatEndInfo): void | Promise<void>;

  /** Fires from `agent.dispose()`. Should release any open resources (DB clients). */
  onClose?(): void | Promise<void>;
}
