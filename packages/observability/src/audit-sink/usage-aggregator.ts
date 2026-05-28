import type { Meter, Histogram, Attributes } from "@opentelemetry/api";
import {
  GEN_AI_OPERATION_NAME,
  GEN_AI_PROVIDER_NAME,
  GEN_AI_REQUEST_MODEL,
  GEN_AI_RESPONSE_MODEL,
  GEN_AI_TOKEN_TYPE,
  GEN_AI_USAGE_INPUT_TOKENS,
  GEN_AI_USAGE_OUTPUT_TOKENS,
  GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS,
  GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS,
  GenAiOperationName,
  GenAiProviderName,
  GenAiTokenType,
  METRIC_GEN_AI_CLIENT_OPERATION_DURATION,
  METRIC_GEN_AI_CLIENT_TOKEN_USAGE,
  METRIC_COMPUTERAGENT_USAGE_COST_USD,
  COMPUTERAGENT_USAGE_COST_USD,
} from "../semantic/attributes.js";

/**
 * Accumulates `ca_usage_snapshot` events into per-session totals, with two
 * jobs:
 *
 *   1. Emit the spec's `gen_ai.client.token.usage` histogram (split into
 *      `gen_ai.token.type = "input"` and `... = "output"` series) and the
 *      `gen_ai.client.operation.duration` histogram.
 *   2. Provide a set of attributes to stamp on the chat/invoke_agent span
 *      before it closes — `gen_ai.usage.input_tokens` etc. plus the
 *      non-spec `computeragent.usage.cost_usd`.
 *
 * Cost semantics:
 *   - `cumulative` (Claude Agent SDK): each snapshot carries the running
 *     total; we keep the max.
 *   - `delta` (gitagent): each snapshot carries a per-message delta; we sum.
 *   - undefined: treat as cumulative (safer — never double-count).
 */

export interface UsageSnapshot {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheCreationInputTokens?: number;
  readonly cacheReadInputTokens?: number;
  readonly costUsd?: number;
  readonly costSemantic?: "cumulative" | "delta";
}

interface SessionTotals {
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  costUsd?: number;
  /** When set, locks in the rule used to combine costUsd across snapshots. */
  costSemantic?: "cumulative" | "delta";
  /** Wall-clock ms when the session first received a snapshot. */
  startedAt: number;
}

export class UsageAggregator {
  private readonly perSession = new Map<string, SessionTotals>();
  private readonly tokenUsage: Histogram;
  private readonly operationDuration: Histogram;
  private readonly costHistogram: Histogram;

  constructor(meter: Meter) {
    this.tokenUsage = meter.createHistogram(METRIC_GEN_AI_CLIENT_TOKEN_USAGE, {
      description: "Measures number of input and output tokens used.",
      unit: "{token}",
    });
    this.operationDuration = meter.createHistogram(METRIC_GEN_AI_CLIENT_OPERATION_DURATION, {
      description: "GenAI operation duration.",
      unit: "s",
    });
    this.costHistogram = meter.createHistogram(METRIC_COMPUTERAGENT_USAGE_COST_USD, {
      description:
        "USD cost reported by the LLM provider. Not in the OTel GenAI spec; namespaced under computeragent.*.",
      unit: "USD",
    });
  }

  /**
   * Record a snapshot. Updates per-session running totals AND emits the
   * `gen_ai.client.token.usage` histogram(s) for any token fields present —
   * the spec is "per LLM call", and a snapshot is the end-of-LLM-call signal.
   */
  ingest(sessionId: string, snapshot: UsageSnapshot, ctx: MetricContext): void {
    const totals = this.getOrCreate(sessionId);
    const semantic = snapshot.costSemantic ?? totals.costSemantic ?? "cumulative";
    totals.costSemantic = semantic;

    if (snapshot.inputTokens !== undefined) {
      totals.inputTokens = (totals.inputTokens ?? 0) + snapshot.inputTokens;
      this.tokenUsage.record(snapshot.inputTokens, {
        ...this.metricAttrs(ctx),
        [GEN_AI_TOKEN_TYPE]: GenAiTokenType.INPUT,
      });
    }
    if (snapshot.outputTokens !== undefined) {
      totals.outputTokens = (totals.outputTokens ?? 0) + snapshot.outputTokens;
      this.tokenUsage.record(snapshot.outputTokens, {
        ...this.metricAttrs(ctx),
        [GEN_AI_TOKEN_TYPE]: GenAiTokenType.OUTPUT,
      });
    }
    if (snapshot.cacheCreationInputTokens !== undefined) {
      totals.cacheCreationInputTokens =
        (totals.cacheCreationInputTokens ?? 0) + snapshot.cacheCreationInputTokens;
    }
    if (snapshot.cacheReadInputTokens !== undefined) {
      totals.cacheReadInputTokens = (totals.cacheReadInputTokens ?? 0) + snapshot.cacheReadInputTokens;
    }

    if (snapshot.costUsd !== undefined) {
      if (semantic === "cumulative") {
        totals.costUsd = Math.max(totals.costUsd ?? 0, snapshot.costUsd);
      } else {
        totals.costUsd = (totals.costUsd ?? 0) + snapshot.costUsd;
      }
    }
  }

  /**
   * Build the span attributes summarising the session's usage. Caller stamps
   * these on the chat/invoke_agent span immediately before `span.end()`.
   */
  spanAttributes(sessionId: string): Attributes {
    const totals = this.perSession.get(sessionId);
    if (!totals) return {};
    const out: Attributes = {};
    if (totals.inputTokens !== undefined) out[GEN_AI_USAGE_INPUT_TOKENS] = totals.inputTokens;
    if (totals.outputTokens !== undefined) out[GEN_AI_USAGE_OUTPUT_TOKENS] = totals.outputTokens;
    if (totals.cacheCreationInputTokens !== undefined) {
      out[GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS] = totals.cacheCreationInputTokens;
    }
    if (totals.cacheReadInputTokens !== undefined) {
      out[GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS] = totals.cacheReadInputTokens;
    }
    if (totals.costUsd !== undefined) out[COMPUTERAGENT_USAGE_COST_USD] = totals.costUsd;
    return out;
  }

  /**
   * Wrap up the session: emit the operation duration + cost histograms and
   * clear the accumulator. Call once on `ca_session_ended`.
   */
  endSession(sessionId: string, ctx: MetricContext, errorType?: string): void {
    const totals = this.perSession.get(sessionId);
    if (!totals) return;
    const durationSec = Math.max(0, (Date.now() - totals.startedAt) / 1000);
    const attrs: Attributes = { ...this.metricAttrs(ctx) };
    if (errorType) attrs["error.type"] = errorType;
    this.operationDuration.record(durationSec, attrs);
    if (totals.costUsd !== undefined) {
      this.costHistogram.record(totals.costUsd, attrs);
    }
    this.perSession.delete(sessionId);
  }

  /** For tests. */
  totalsFor(sessionId: string): Readonly<SessionTotals> | undefined {
    return this.perSession.get(sessionId);
  }

  private getOrCreate(sessionId: string): SessionTotals {
    let totals = this.perSession.get(sessionId);
    if (!totals) {
      totals = { startedAt: Date.now() };
      this.perSession.set(sessionId, totals);
    }
    return totals;
  }

  private metricAttrs(ctx: MetricContext): Attributes {
    const attrs: Attributes = {
      [GEN_AI_OPERATION_NAME]: ctx.operationName,
      [GEN_AI_PROVIDER_NAME]: ctx.providerName,
    };
    if (ctx.requestModel) attrs[GEN_AI_REQUEST_MODEL] = ctx.requestModel;
    if (ctx.responseModel) attrs[GEN_AI_RESPONSE_MODEL] = ctx.responseModel;
    return attrs;
  }
}

export interface MetricContext {
  readonly operationName: GenAiOperationName;
  readonly providerName: GenAiProviderName | string;
  readonly requestModel?: string;
  readonly responseModel?: string;
}
