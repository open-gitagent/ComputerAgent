import { describe, it, expect } from "vitest";
import {
  GEN_AI_OPERATION_NAME,
  GEN_AI_PROVIDER_NAME,
  GEN_AI_AGENT_NAME,
  GEN_AI_CONVERSATION_ID,
  GEN_AI_TOOL_NAME,
  GEN_AI_TOOL_CALL_ID,
  GEN_AI_USAGE_INPUT_TOKENS,
  GEN_AI_USAGE_OUTPUT_TOKENS,
  GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS,
  GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS,
  GEN_AI_TOKEN_TYPE,
  GenAiOperationName,
  GenAiProviderName,
  GenAiTokenType,
  TOKEN_USAGE_BUCKETS,
  OPERATION_DURATION_BUCKETS,
  COST_USD_BUCKETS,
  METRIC_GEN_AI_CLIENT_TOKEN_USAGE,
  METRIC_GEN_AI_CLIENT_OPERATION_DURATION,
  COMPUTERAGENT_ENGINE_NAME,
  COMPUTERAGENT_USAGE_COST_USD,
  EVENT_GEN_AI_CLIENT_INFERENCE_OPERATION_DETAILS,
} from "./attributes.js";

describe("semantic constants", () => {
  it("uses the exact gen_ai.* attribute keys from the registry", () => {
    // These are spec-exact strings. If anyone fat-fingers a rename here,
    // backends silently ignore the offending key — so we lock them down.
    expect(GEN_AI_OPERATION_NAME).toBe("gen_ai.operation.name");
    expect(GEN_AI_PROVIDER_NAME).toBe("gen_ai.provider.name");
    expect(GEN_AI_AGENT_NAME).toBe("gen_ai.agent.name");
    expect(GEN_AI_CONVERSATION_ID).toBe("gen_ai.conversation.id");
    expect(GEN_AI_TOOL_NAME).toBe("gen_ai.tool.name");
    expect(GEN_AI_TOOL_CALL_ID).toBe("gen_ai.tool.call.id");
    expect(GEN_AI_USAGE_INPUT_TOKENS).toBe("gen_ai.usage.input_tokens");
    expect(GEN_AI_USAGE_OUTPUT_TOKENS).toBe("gen_ai.usage.output_tokens");
    expect(GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS).toBe("gen_ai.usage.cache_creation.input_tokens");
    expect(GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS).toBe("gen_ai.usage.cache_read.input_tokens");
    expect(GEN_AI_TOKEN_TYPE).toBe("gen_ai.token.type");
  });

  it("uses the exact gen_ai.client.* metric names", () => {
    expect(METRIC_GEN_AI_CLIENT_TOKEN_USAGE).toBe("gen_ai.client.token.usage");
    expect(METRIC_GEN_AI_CLIENT_OPERATION_DURATION).toBe("gen_ai.client.operation.duration");
  });

  it("includes every spec-defined operation name", () => {
    expect(GenAiOperationName.CHAT).toBe("chat");
    expect(GenAiOperationName.INVOKE_AGENT).toBe("invoke_agent");
    expect(GenAiOperationName.EXECUTE_TOOL).toBe("execute_tool");
    expect(GenAiOperationName.EMBEDDINGS).toBe("embeddings");
    expect(GenAiOperationName.RETRIEVAL).toBe("retrieval");
  });

  it("includes Anthropic in the spec-defined provider enum", () => {
    expect(GenAiProviderName.ANTHROPIC).toBe("anthropic");
    expect(GenAiProviderName.OPENAI).toBe("openai");
  });

  it("token-type enum has exactly input + output (no cache values)", () => {
    expect(GenAiTokenType.INPUT).toBe("input");
    expect(GenAiTokenType.OUTPUT).toBe("output");
    // Cache tokens are recorded via gen_ai.usage.cache_* attributes, NOT as a
    // gen_ai.token.type enum value. Make sure we don't drift.
    expect(Object.values(GenAiTokenType)).toEqual(["input", "output"]);
  });

  it("token-usage histogram buckets match the spec verbatim", () => {
    expect(TOKEN_USAGE_BUCKETS).toEqual([
      1, 4, 16, 64, 256, 1024, 4096, 16384, 65536, 262144, 1048576, 4194304, 16777216, 67108864,
    ]);
  });

  it("operation-duration histogram buckets match the spec verbatim", () => {
    expect(OPERATION_DURATION_BUCKETS).toEqual([
      0.01, 0.02, 0.04, 0.08, 0.16, 0.32, 0.64, 1.28, 2.56, 5.12, 10.24, 20.48, 40.96, 81.92,
    ]);
  });

  it("cost histogram buckets are strictly ascending and cover the typical LLM cost range", () => {
    // Not in the spec — these are tuned for USD per LLM call (Haiku → Opus).
    // Lock them down so a future drift to SDK-default buckets is caught.
    expect(COST_USD_BUCKETS).toEqual([
      0.0001, 0.001, 0.01, 0.05, 0.1, 0.5, 1, 5, 10, 50, 100,
    ]);
    // ExplicitBucketHistogramAggregation requires strictly ascending.
    for (let i = 1; i < COST_USD_BUCKETS.length; i++) {
      expect(COST_USD_BUCKETS[i]).toBeGreaterThan(COST_USD_BUCKETS[i - 1]!);
    }
  });

  it("namespaces non-spec extensions under computeragent.*", () => {
    expect(COMPUTERAGENT_ENGINE_NAME.startsWith("computeragent.")).toBe(true);
    expect(COMPUTERAGENT_USAGE_COST_USD.startsWith("computeragent.")).toBe(true);
    // Never sneak custom attributes into the gen_ai.* namespace.
    expect(COMPUTERAGENT_ENGINE_NAME.startsWith("gen_ai.")).toBe(false);
    expect(COMPUTERAGENT_USAGE_COST_USD.startsWith("gen_ai.")).toBe(false);
  });

  it("uses the spec event name for inference details", () => {
    expect(EVENT_GEN_AI_CLIENT_INFERENCE_OPERATION_DETAILS).toBe(
      "gen_ai.client.inference.operation.details",
    );
  });
});
