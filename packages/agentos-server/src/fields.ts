// Whitelist of query-builder fields. Each entry binds a UI-facing key to a
// ClickHouse expression + NRQL attribute path + allowed operators. Hand-mirrored
// to agentos/src/obs-fields.ts (v1); extract to a shared workspace package
// later if it drifts.
//
// Two backend forms per field during the migration:
//   - sqlExpr   — ClickHouse SQL fragment (used when TRACE_BACKEND=clickhouse)
//   - nrqlAttr  — NRQL attribute path  (used when TRACE_BACKEND=newrelic)
//
// New Relic's OTLP receiver flattens OTel span attributes onto the Span event
// using dotted names — `gen_ai.agent.name` becomes the attribute literally
// named `gen_ai.agent.name` on the Span. Numeric attributes are auto-coerced,
// so the ClickHouse `toFloat64OrZero(...)` / `toUInt32OrZero(...)` wrappers are
// unnecessary on the NRQL side.

export type Operator = "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "in" | "not_in" | "contains" | "exists";

export type FieldDef = {
  key: string;
  label: string;
  type: "string" | "number" | "enum";
  /** ClickHouse SQL expression. Kept for the legacy backend until the cut-over. */
  sqlExpr: string;
  /** NRQL attribute path on the `Span` event. Used by the New Relic adapter. */
  nrqlAttr: string;
  /** Type hint for the ClickHouse query-builder's {param:Type} placeholders. */
  paramType: "String" | "UInt32" | "Float64";
  ops: Operator[];
  enumValues?: string[];
};

export const FIELDS: Record<string, FieldDef> = {
  agent: {
    key: "agent",
    label: "Agent",
    type: "string",
    sqlExpr: "SpanAttributes['gen_ai.agent.name']",
    nrqlAttr: "gen_ai.agent.name",
    paramType: "String",
    ops: ["eq", "neq", "in", "not_in", "exists"],
  },
  model: {
    key: "model",
    label: "Model",
    type: "string",
    sqlExpr: "SpanAttributes['gen_ai.request.model']",
    nrqlAttr: "gen_ai.request.model",
    paramType: "String",
    ops: ["eq", "neq", "in", "not_in", "exists"],
  },
  operation: {
    key: "operation",
    label: "Operation",
    type: "enum",
    sqlExpr: "SpanAttributes['gen_ai.operation.name']",
    nrqlAttr: "gen_ai.operation.name",
    paramType: "String",
    ops: ["eq", "neq", "in"],
    enumValues: ["invoke_agent", "chat", "execute_tool", "embeddings", "generate_content", "text_completion"],
  },
  provider: {
    key: "provider",
    label: "Provider",
    type: "string",
    sqlExpr: "SpanAttributes['gen_ai.provider.name']",
    nrqlAttr: "gen_ai.provider.name",
    paramType: "String",
    ops: ["eq", "neq", "in", "not_in", "exists"],
  },
  tool: {
    key: "tool",
    label: "Tool",
    type: "string",
    sqlExpr: "SpanAttributes['gen_ai.tool.name']",
    nrqlAttr: "gen_ai.tool.name",
    paramType: "String",
    ops: ["eq", "neq", "in", "contains", "exists"],
  },
  conversation_id: {
    key: "conversation_id",
    label: "Conversation",
    type: "string",
    sqlExpr: "SpanAttributes['gen_ai.conversation.id']",
    nrqlAttr: "gen_ai.conversation.id",
    paramType: "String",
    ops: ["eq", "contains"],
  },
  service: {
    key: "service",
    label: "Service",
    type: "string",
    sqlExpr: "ServiceName",
    // New Relic maps OTel service.name onto the special `service.name` attribute.
    nrqlAttr: "service.name",
    paramType: "String",
    ops: ["eq", "neq", "in"],
  },
  span_name: {
    key: "span_name",
    label: "Span Name",
    type: "string",
    sqlExpr: "SpanName",
    // Span.name in New Relic.
    nrqlAttr: "name",
    paramType: "String",
    ops: ["eq", "neq", "contains"],
  },
  duration_ms: {
    key: "duration_ms",
    label: "Duration (ms)",
    type: "number",
    sqlExpr: "(Duration / 1e6)",
    // New Relic exposes span duration in milliseconds as `duration.ms`.
    nrqlAttr: "duration.ms",
    paramType: "Float64",
    ops: ["gt", "gte", "lt", "lte", "eq"],
  },
  input_tokens: {
    key: "input_tokens",
    label: "Input Tokens",
    type: "number",
    sqlExpr: "toUInt32OrZero(SpanAttributes['gen_ai.usage.input_tokens'])",
    nrqlAttr: "gen_ai.usage.input_tokens",
    paramType: "UInt32",
    ops: ["gt", "gte", "lt", "lte", "eq"],
  },
  output_tokens: {
    key: "output_tokens",
    label: "Output Tokens",
    type: "number",
    sqlExpr: "toUInt32OrZero(SpanAttributes['gen_ai.usage.output_tokens'])",
    nrqlAttr: "gen_ai.usage.output_tokens",
    paramType: "UInt32",
    ops: ["gt", "gte", "lt", "lte", "eq"],
  },
  cost_usd: {
    key: "cost_usd",
    label: "Cost (USD)",
    type: "number",
    sqlExpr: "toFloat64OrZero(SpanAttributes['computeragent.usage.cost_usd'])",
    nrqlAttr: "computeragent.usage.cost_usd",
    paramType: "Float64",
    ops: ["gt", "gte", "lt", "lte", "eq"],
  },
  status: {
    key: "status",
    label: "Status",
    type: "enum",
    sqlExpr: "StatusCode",
    // New Relic uses `otel.status_code` for the OTel status enum.
    nrqlAttr: "otel.status_code",
    paramType: "String",
    ops: ["eq", "neq"],
    enumValues: ["Unset", "Ok", "Error", "STATUS_CODE_UNSET", "STATUS_CODE_OK", "STATUS_CODE_ERROR"],
  },
};
