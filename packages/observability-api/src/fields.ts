// Whitelist of query-builder fields. Each entry binds a UI-facing key to a
// ClickHouse expression + allowed operators. Hand-mirrored to agentos/src/
// obs-fields.ts (v1); extract to a shared workspace package later if it drifts.

export type Operator = "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "in" | "not_in" | "contains" | "exists";

export type FieldDef = {
  key: string;
  label: string;
  type: "string" | "number" | "enum";
  sqlExpr: string;
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
    paramType: "String",
    ops: ["eq", "neq", "in", "not_in", "exists"],
  },
  model: {
    key: "model",
    label: "Model",
    type: "string",
    sqlExpr: "SpanAttributes['gen_ai.request.model']",
    paramType: "String",
    ops: ["eq", "neq", "in", "not_in", "exists"],
  },
  operation: {
    key: "operation",
    label: "Operation",
    type: "enum",
    sqlExpr: "SpanAttributes['gen_ai.operation.name']",
    paramType: "String",
    ops: ["eq", "neq", "in"],
    enumValues: ["invoke_agent", "chat", "execute_tool", "embeddings", "generate_content", "text_completion"],
  },
  provider: {
    key: "provider",
    label: "Provider",
    type: "string",
    sqlExpr: "SpanAttributes['gen_ai.provider.name']",
    paramType: "String",
    ops: ["eq", "neq", "in", "not_in", "exists"],
  },
  tool: {
    key: "tool",
    label: "Tool",
    type: "string",
    sqlExpr: "SpanAttributes['gen_ai.tool.name']",
    paramType: "String",
    ops: ["eq", "neq", "in", "contains", "exists"],
  },
  conversation_id: {
    key: "conversation_id",
    label: "Conversation",
    type: "string",
    sqlExpr: "SpanAttributes['gen_ai.conversation.id']",
    paramType: "String",
    ops: ["eq", "contains"],
  },
  service: {
    key: "service",
    label: "Service",
    type: "string",
    sqlExpr: "ServiceName",
    paramType: "String",
    ops: ["eq", "neq", "in"],
  },
  span_name: {
    key: "span_name",
    label: "Span Name",
    type: "string",
    sqlExpr: "SpanName",
    paramType: "String",
    ops: ["eq", "neq", "contains"],
  },
  duration_ms: {
    key: "duration_ms",
    label: "Duration (ms)",
    type: "number",
    sqlExpr: "(Duration / 1e6)",
    paramType: "Float64",
    ops: ["gt", "gte", "lt", "lte", "eq"],
  },
  input_tokens: {
    key: "input_tokens",
    label: "Input Tokens",
    type: "number",
    sqlExpr: "toUInt32OrZero(SpanAttributes['gen_ai.usage.input_tokens'])",
    paramType: "UInt32",
    ops: ["gt", "gte", "lt", "lte", "eq"],
  },
  output_tokens: {
    key: "output_tokens",
    label: "Output Tokens",
    type: "number",
    sqlExpr: "toUInt32OrZero(SpanAttributes['gen_ai.usage.output_tokens'])",
    paramType: "UInt32",
    ops: ["gt", "gte", "lt", "lte", "eq"],
  },
  cost_usd: {
    key: "cost_usd",
    label: "Cost (USD)",
    type: "number",
    sqlExpr: "toFloat64OrZero(SpanAttributes['computeragent.usage.cost_usd'])",
    paramType: "Float64",
    ops: ["gt", "gte", "lt", "lte", "eq"],
  },
  status: {
    key: "status",
    label: "Status",
    type: "enum",
    sqlExpr: "StatusCode",
    paramType: "String",
    ops: ["eq", "neq"],
    enumValues: ["Unset", "Ok", "Error", "STATUS_CODE_UNSET", "STATUS_CODE_OK", "STATUS_CODE_ERROR"],
  },
};
