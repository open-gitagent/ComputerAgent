import type {
  PolicyDecider,
  PolicyDecision,
  SrsPolicyConfig,
  ToolCallContext,
} from "@computeragent/protocol";

/**
 * SrsPolicyDecider — calls Lyzr SRS to gate tool calls.
 *
 * Fetches the RAI policy once (GET /v1/rai/policies/{policy_id}), caches
 * the cedar_guardrail + opa_guardrail subsections, and on every evaluate()
 * POSTs to /v1/guardrails/evaluate-tool-call with the cached configs +
 * tool_name + tool_args + principal_id.
 *
 * The SRS endpoint takes inline guardrail configs (not policy_id) today —
 * caching the once-fetched policy keeps every tool call to one round-trip.
 * If SRS later ships a policy_id-aware tool-call endpoint, this class
 * swaps its body without changing PolicyDecider's public shape.
 *
 * Failure policy: if SRS returns 5xx or times out, default DENY. Caller can
 * change this by wrapping in a permissive decider; the default here is
 * fail-closed because a guardrail outage shouldn't silently disable
 * enforcement.
 */
export class SrsPolicyDecider implements PolicyDecider {
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly policyId: string;
  private readonly principalId: string;
  private policyCache: { cedar?: unknown; opa?: unknown } | null = null;
  private cachePromise: Promise<void> | null = null;

  constructor(cfg: SrsPolicyConfig) {
    this.endpoint = cfg.endpoint.replace(/\/+$/, "");
    this.apiKey = cfg.apiKey;
    this.policyId = cfg.policyId;
    this.principalId = cfg.principalId;
  }

  private async loadPolicy(): Promise<void> {
    if (this.policyCache) return;
    if (this.cachePromise) return this.cachePromise;
    this.cachePromise = (async () => {
      const r = await fetch(`${this.endpoint}/v1/rai/policies/${encodeURIComponent(this.policyId)}`, {
        headers: { "x-api-key": this.apiKey },
      });
      if (!r.ok) {
        const text = await r.text().catch(() => "");
        throw new Error(`SRS policy fetch failed (${r.status}): ${text.slice(0, 200)}`);
      }
      const doc = await r.json() as { cedar_guardrail?: unknown; opa_guardrail?: unknown };
      this.policyCache = { cedar: doc.cedar_guardrail, opa: doc.opa_guardrail };
    })();
    try {
      await this.cachePromise;
    } finally {
      this.cachePromise = null;
    }
  }

  async evaluate(ctx: ToolCallContext): Promise<PolicyDecision> {
    try {
      await this.loadPolicy();
    } catch (err) {
      return { allowed: false, deniedBy: "srs", reason: `policy load failed: ${(err as Error).message}` };
    }
    const body = {
      cedar_guardrail: this.policyCache?.cedar ?? undefined,
      opa_guardrail: this.policyCache?.opa ?? undefined,
      tool_name: ctx.toolName,
      tool_args: ctx.toolArgs,
      principal_id: this.principalId,
      bundle_id: ctx.agentName,
      bundle_name: ctx.agentName,
    };
    try {
      const r = await fetch(`${this.endpoint}/v1/guardrails/evaluate-tool-call`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": this.apiKey },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const text = await r.text().catch(() => "");
        return { allowed: false, deniedBy: "srs", reason: `SRS ${r.status}: ${text.slice(0, 200)}` };
      }
      const out = await r.json() as { allowed?: boolean; denied_by?: string; reason?: string };
      return {
        allowed: !!out.allowed,
        ...(out.denied_by ? { deniedBy: out.denied_by } : {}),
        ...(out.reason ? { reason: out.reason } : {}),
      };
    } catch (err) {
      return { allowed: false, deniedBy: "srs", reason: `SRS unreachable: ${(err as Error).message}` };
    }
  }
}
