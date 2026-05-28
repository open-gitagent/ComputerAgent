/**
 * Policy abstraction — engine-agnostic per-tool-call authorization.
 *
 * Inspired by Lyzr SRS's `/v1/guardrails/evaluate-tool-call`: one universal
 * tool-call shape, one allow/deny decision, no engine-specific knowledge.
 * Implementations bridge to the actual enforcement engine (Cedar/OPA via
 * SRS, or local impls).
 *
 * The harness runs the decider INSIDE the per-session permission wrapper
 * (see harness-server/services/run-session.ts). If the decider says deny,
 * the harness returns a deny PermissionResult to the engine immediately —
 * no SSE round-trip to a client. If it says allow, the harness short-circuits
 * the round-trip and resolves the permission as allow.
 */

/** What the harness hands to the decider for each tool call. */
export interface ToolCallContext {
  /** Stable agent identifier (e.g. "claude-code", "gitagent"). */
  readonly agentName: string;
  /** Session this tool call belongs to. */
  readonly sessionId: string;
  /** Tool the engine wants to invoke (e.g. "Bash", "Read", "Write"). */
  readonly toolName: string;
  /** Tool input the engine wants to invoke it with. */
  readonly toolArgs: Record<string, unknown>;
  /** Caller identity passed to the policy engine — forwarded for audit. */
  readonly principalId: string;
}

/** What the decider returns to the harness. */
export interface PolicyDecision {
  readonly allowed: boolean;
  /** Which sub-engine produced the deny (e.g. "cedar", "opa", "srs"). */
  readonly deniedBy?: string;
  /** Human-readable reason — surfaced to the engine and audit log. */
  readonly reason?: string;
}

/** Engine-agnostic policy contract. One method, sync/async indifferent. */
export interface PolicyDecider {
  evaluate(ctx: ToolCallContext): Promise<PolicyDecision>;
}

/**
 * Wire-side policy config carried on session-create requests. The harness
 * builds the right decider from `kind`.
 *
 *   { kind: "srs", endpoint: "...", apiKey: "...", policyId: "...", principalId: "..." }
 */
export type PolicyConfig = SrsPolicyConfig;

export interface SrsPolicyConfig {
  readonly kind: "srs";
  /** SRS base URL — e.g. "https://srs-dev.test.studio.lyzr.ai". */
  readonly endpoint: string;
  /** x-api-key for SRS. Never leaves the harness. */
  readonly apiKey: string;
  /** RAI policy_id whose cedar_guardrail + opa_guardrail to apply. */
  readonly policyId: string;
  /** Forwarded to SRS as the `principal_id` for audit. */
  readonly principalId: string;
}
