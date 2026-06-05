/**
 * OpenTelemetry GenAI Semantic Conventions — attribute, metric, event, and
 * value constants. Sourced from the official spec registry:
 *
 *   https://opentelemetry.io/docs/specs/semconv/registry/attributes/gen-ai/
 *   https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-spans/
 *   https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-agent-spans/
 *   https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-metrics/
 *   https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-events/
 *
 * Spec version targeted: semconv v1.40 (status: Development; client spans
 * exited Experimental in early 2026).
 *
 * Rule: every `gen_ai.*` constant in this file maps to a key the spec
 * registry recognizes. ComputerAgent-specific extensions live under the
 * `COMPUTERAGENT_*` block at the bottom and use the documented
 * `computeragent.*` prefix — never `gen_ai.*`.
 */

// ---------------------------------------------------------------------------
// Operation
// ---------------------------------------------------------------------------

/** `gen_ai.operation.name` — type of operation being performed. */
export const GEN_AI_OPERATION_NAME = "gen_ai.operation.name" as const;

/** Spec-defined values for `gen_ai.operation.name`. */
export const GenAiOperationName = {
  CHAT: "chat",
  TEXT_COMPLETION: "text_completion",
  EMBEDDINGS: "embeddings",
  GENERATE_CONTENT: "generate_content",
  CREATE_AGENT: "create_agent",
  INVOKE_AGENT: "invoke_agent",
  INVOKE_WORKFLOW: "invoke_workflow",
  EXECUTE_TOOL: "execute_tool",
  RETRIEVAL: "retrieval",
} as const;
export type GenAiOperationName = (typeof GenAiOperationName)[keyof typeof GenAiOperationName];

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/** `gen_ai.provider.name` — LLM backend identity (NOT the agent framework). */
export const GEN_AI_PROVIDER_NAME = "gen_ai.provider.name" as const;

/** Spec-defined values for `gen_ai.provider.name`. */
export const GenAiProviderName = {
  OPENAI: "openai",
  ANTHROPIC: "anthropic",
  AWS_BEDROCK: "aws.bedrock",
  AZURE_AI_OPENAI: "azure.ai.openai",
  AZURE_AI_INFERENCE: "azure.ai.inference",
  GCP_GEMINI: "gcp.gemini",
  GCP_VERTEX_AI: "gcp.vertex_ai",
  GCP_GEN_AI: "gcp.gen_ai",
  COHERE: "cohere",
  DEEPSEEK: "deepseek",
  GROQ: "groq",
  MISTRAL_AI: "mistral_ai",
  PERPLEXITY: "perplexity",
  X_AI: "x_ai",
  IBM_WATSONX_AI: "ibm.watsonx.ai",
} as const;
export type GenAiProviderName = (typeof GenAiProviderName)[keyof typeof GenAiProviderName];

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

export const GEN_AI_AGENT_NAME = "gen_ai.agent.name" as const;
export const GEN_AI_AGENT_ID = "gen_ai.agent.id" as const;
export const GEN_AI_AGENT_VERSION = "gen_ai.agent.version" as const;
export const GEN_AI_AGENT_DESCRIPTION = "gen_ai.agent.description" as const;

// ---------------------------------------------------------------------------
// Conversation / workflow
// ---------------------------------------------------------------------------

/** `gen_ai.conversation.id` — correlates multiple invocations of an agent. */
export const GEN_AI_CONVERSATION_ID = "gen_ai.conversation.id" as const;
export const GEN_AI_WORKFLOW_NAME = "gen_ai.workflow.name" as const;

// ---------------------------------------------------------------------------
// Request parameters
// ---------------------------------------------------------------------------

export const GEN_AI_REQUEST_MODEL = "gen_ai.request.model" as const;
export const GEN_AI_REQUEST_TEMPERATURE = "gen_ai.request.temperature" as const;
export const GEN_AI_REQUEST_TOP_P = "gen_ai.request.top_p" as const;
export const GEN_AI_REQUEST_TOP_K = "gen_ai.request.top_k" as const;
export const GEN_AI_REQUEST_MAX_TOKENS = "gen_ai.request.max_tokens" as const;
export const GEN_AI_REQUEST_FREQUENCY_PENALTY = "gen_ai.request.frequency_penalty" as const;
export const GEN_AI_REQUEST_PRESENCE_PENALTY = "gen_ai.request.presence_penalty" as const;
export const GEN_AI_REQUEST_STOP_SEQUENCES = "gen_ai.request.stop_sequences" as const;
export const GEN_AI_REQUEST_SEED = "gen_ai.request.seed" as const;
export const GEN_AI_REQUEST_STREAM = "gen_ai.request.stream" as const;
export const GEN_AI_REQUEST_CHOICE_COUNT = "gen_ai.request.choice.count" as const;
export const GEN_AI_REQUEST_ENCODING_FORMATS = "gen_ai.request.encoding_formats" as const;

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

export const GEN_AI_RESPONSE_MODEL = "gen_ai.response.model" as const;
export const GEN_AI_RESPONSE_ID = "gen_ai.response.id" as const;
export const GEN_AI_RESPONSE_FINISH_REASONS = "gen_ai.response.finish_reasons" as const;
export const GEN_AI_RESPONSE_TIME_TO_FIRST_CHUNK = "gen_ai.response.time_to_first_chunk" as const;

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

export const GEN_AI_USAGE_INPUT_TOKENS = "gen_ai.usage.input_tokens" as const;
export const GEN_AI_USAGE_OUTPUT_TOKENS = "gen_ai.usage.output_tokens" as const;
export const GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS = "gen_ai.usage.cache_creation.input_tokens" as const;
export const GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS = "gen_ai.usage.cache_read.input_tokens" as const;
export const GEN_AI_USAGE_REASONING_OUTPUT_TOKENS = "gen_ai.usage.reasoning.output_tokens" as const;

/** `gen_ai.token.type` — required for the token-usage histogram. */
export const GEN_AI_TOKEN_TYPE = "gen_ai.token.type" as const;
export const GenAiTokenType = {
  INPUT: "input",
  OUTPUT: "output",
} as const;
export type GenAiTokenType = (typeof GenAiTokenType)[keyof typeof GenAiTokenType];

// ---------------------------------------------------------------------------
// Input / output / system instructions (content — opt-in only)
// ---------------------------------------------------------------------------

export const GEN_AI_INPUT_MESSAGES = "gen_ai.input.messages" as const;
export const GEN_AI_OUTPUT_MESSAGES = "gen_ai.output.messages" as const;
export const GEN_AI_OUTPUT_TYPE = "gen_ai.output.type" as const;
export const GEN_AI_SYSTEM_INSTRUCTIONS = "gen_ai.system_instructions" as const;

/** Spec-defined values for `gen_ai.output.type`. */
export const GenAiOutputType = {
  TEXT: "text",
  JSON: "json",
  IMAGE: "image",
  SPEECH: "speech",
} as const;
export type GenAiOutputType = (typeof GenAiOutputType)[keyof typeof GenAiOutputType];

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

export const GEN_AI_TOOL_NAME = "gen_ai.tool.name" as const;
export const GEN_AI_TOOL_DESCRIPTION = "gen_ai.tool.description" as const;
export const GEN_AI_TOOL_TYPE = "gen_ai.tool.type" as const;
export const GEN_AI_TOOL_CALL_ID = "gen_ai.tool.call.id" as const;
export const GEN_AI_TOOL_CALL_ARGUMENTS = "gen_ai.tool.call.arguments" as const;
export const GEN_AI_TOOL_CALL_RESULT = "gen_ai.tool.call.result" as const;
export const GEN_AI_TOOL_DEFINITIONS = "gen_ai.tool.definitions" as const;

/** Spec-defined values for `gen_ai.tool.type`. */
export const GenAiToolType = {
  FUNCTION: "function",
  EXTENSION: "extension",
  DATASTORE: "datastore",
} as const;
export type GenAiToolType = (typeof GenAiToolType)[keyof typeof GenAiToolType];

// ---------------------------------------------------------------------------
// Retrieval (RAG)
// ---------------------------------------------------------------------------

export const GEN_AI_DATA_SOURCE_ID = "gen_ai.data_source.id" as const;
export const GEN_AI_RETRIEVAL_QUERY_TEXT = "gen_ai.retrieval.query.text" as const;
export const GEN_AI_RETRIEVAL_DOCUMENTS = "gen_ai.retrieval.documents" as const;

// ---------------------------------------------------------------------------
// Standard (non-gen_ai) attribute keys we use
// ---------------------------------------------------------------------------

/** `error.type` — set on spans when the operation fails. */
export const ERROR_TYPE = "error.type" as const;
export const SERVER_ADDRESS = "server.address" as const;
export const SERVER_PORT = "server.port" as const;

// ---------------------------------------------------------------------------
// Metric names (gen_ai.client.* histograms)
// ---------------------------------------------------------------------------

/** Histogram — token consumption per LLM call. Unit: `{token}`. */
export const METRIC_GEN_AI_CLIENT_TOKEN_USAGE = "gen_ai.client.token.usage" as const;

/** Histogram — total operation duration. Unit: `s`. */
export const METRIC_GEN_AI_CLIENT_OPERATION_DURATION = "gen_ai.client.operation.duration" as const;

/** Histogram — streaming time-to-first-chunk. Unit: `s`. */
export const METRIC_GEN_AI_CLIENT_TIME_TO_FIRST_CHUNK = "gen_ai.client.operation.time_to_first_chunk" as const;

/** Histogram — streaming time-per-output-chunk. Unit: `s`. */
export const METRIC_GEN_AI_CLIENT_TIME_PER_OUTPUT_CHUNK = "gen_ai.client.operation.time_per_output_chunk" as const;

// ---------------------------------------------------------------------------
// Histogram bucket boundaries — taken verbatim from the spec, do NOT alter.
// ---------------------------------------------------------------------------

/** Spec bucket boundaries for `gen_ai.client.token.usage`. */
export const TOKEN_USAGE_BUCKETS: readonly number[] = [
  1, 4, 16, 64, 256, 1024, 4096, 16384, 65536, 262144, 1048576, 4194304, 16777216, 67108864,
] as const;

/**
 * Spec bucket boundaries for all `gen_ai.client.operation.*` duration
 * histograms (operation.duration, time_to_first_chunk, time_per_output_chunk).
 */
export const OPERATION_DURATION_BUCKETS: readonly number[] = [
  0.01, 0.02, 0.04, 0.08, 0.16, 0.32, 0.64, 1.28, 2.56, 5.12, 10.24, 20.48, 40.96, 81.92,
] as const;

/**
 * Bucket boundaries for `computeragent.usage.cost_usd`. NOT spec-defined —
 * cost is not in the OTel GenAI spec at all. Tuned for typical LLM-call
 * costs:
 *   - Haiku-class:      $0.0001 – $0.01 / call
 *   - Sonnet-class:     $0.01   – $0.50 / call
 *   - Opus-class:       $0.10   – $5.00 / call
 *   - Cache-spike outlier or long-context call: up to ~$50
 *
 * Order matters: ExplicitBucketHistogramAggregation requires strictly
 * ascending values.
 */
export const COST_USD_BUCKETS: readonly number[] = [
  0.0001, 0.001, 0.01, 0.05, 0.1, 0.5, 1, 5, 10, 50, 100,
] as const;

// ---------------------------------------------------------------------------
// Event names
// ---------------------------------------------------------------------------

/**
 * `gen_ai.client.inference.operation.details` — opt-in structured log event
 * carrying input/output messages and system instructions when
 * `captureContentMode = "events"` (spec-preferred for high-volume content).
 */
export const EVENT_GEN_AI_CLIENT_INFERENCE_OPERATION_DETAILS =
  "gen_ai.client.inference.operation.details" as const;

/** `gen_ai.evaluation.result` — evaluation metric/quality assessment events. */
export const EVENT_GEN_AI_EVALUATION_RESULT = "gen_ai.evaluation.result" as const;

// ---------------------------------------------------------------------------
// Custom (computeragent.*) — NOT in the GenAI spec; namespaced to avoid
// collisions with future spec additions.
// ---------------------------------------------------------------------------

/** Engine name (e.g. "claude-agent-sdk", "gitagent"). NOT the LLM provider. */
export const COMPUTERAGENT_ENGINE_NAME = "computeragent.engine.name" as const;

// --- RBAC / multi-tenancy identity (per agent invocation) ------------------
// Stamped on every span of an invocation so traces can be aggregated and
// access-controlled by the AgentOS RBAC/groups model. Distinct from
// `gen_ai.agent.id` (which is the GAP source SHA) — this is the registry id.

/** AgentOS registry doc id (ObjectId hex) of the invoked agent. */
export const COMPUTERAGENT_AGENT_ID = "computeragent.agent.id" as const;

/** Owning group (Keycloak group) — the tenancy/visibility key. */
export const COMPUTERAGENT_GROUP_ID = "computeragent.group.id" as const;

/** Owning user (agent creator's principal id). */
export const COMPUTERAGENT_OWNER_ID = "computeragent.owner.id" as const;

/** Invoking principal id — who triggered this run. */
export const COMPUTERAGENT_ACTOR_ID = "computeragent.actor.id" as const;

/** USD cost as reported by the provider. The GenAI spec has no cost key. */
export const COMPUTERAGENT_USAGE_COST_USD = "computeragent.usage.cost_usd" as const;

/** Internal metric name for cost. */
export const METRIC_COMPUTERAGENT_USAGE_COST_USD = "computeragent.usage.cost_usd" as const;

/** Tracer + meter instrumentation scope name. */
export const INSTRUMENTATION_SCOPE_NAME = "@computeragent/observability" as const;
