// Hand-mirrored copy of packages/observability-api/src/fields.ts. Stays in sync
// because the server validates every filter against its own whitelist — if this
// ever drifts, the API rejects with 400 BadQueryError.

export type Operator =
  | "eq"
  | "neq"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "in"
  | "not_in"
  | "contains"
  | "exists";

// `type` controls the value-input UX, not the value source. The backend
// (otel_field_values MV) is the source of truth for *all* string + enum
// fields — no hardcoded options ride in this file anymore.
export type FieldDef = {
  key: string;
  label: string;
  type: "string" | "number" | "enum";
  ops: Operator[];
};

export const OP_LABEL: Record<Operator, string> = {
  eq: "=",
  neq: "≠",
  gt: ">",
  gte: "≥",
  lt: "<",
  lte: "≤",
  in: "in",
  not_in: "not in",
  contains: "contains",
  exists: "exists",
};

export const FIELDS: FieldDef[] = [
  { key: "agent",           label: "Agent",          type: "string", ops: ["eq", "neq", "in", "not_in", "exists"] },
  { key: "model",           label: "Model",          type: "string", ops: ["eq", "neq", "in", "not_in", "exists"] },
  { key: "operation",       label: "Operation",      type: "enum",   ops: ["eq", "neq", "in"] },
  { key: "provider",        label: "Provider",       type: "string", ops: ["eq", "neq", "in", "not_in", "exists"] },
  { key: "tool",            label: "Tool",           type: "string", ops: ["eq", "neq", "in", "contains", "exists"] },
  { key: "conversation_id", label: "Conversation",   type: "string", ops: ["eq", "contains"] },
  { key: "service",         label: "Service",        type: "string", ops: ["eq", "neq", "in"] },
  { key: "span_name",       label: "Span Name",      type: "string", ops: ["eq", "neq", "contains"] },
  { key: "duration_ms",     label: "Duration (ms)",  type: "number", ops: ["gt", "gte", "lt", "lte", "eq"] },
  { key: "input_tokens",    label: "Input Tokens",   type: "number", ops: ["gt", "gte", "lt", "lte", "eq"] },
  { key: "output_tokens",   label: "Output Tokens",  type: "number", ops: ["gt", "gte", "lt", "lte", "eq"] },
  { key: "cost_usd",        label: "Cost (USD)",     type: "number", ops: ["gt", "gte", "lt", "lte", "eq"] },
  { key: "status",          label: "Status",         type: "enum",   ops: ["eq", "neq"] },
];

export function fieldByKey(key: string): FieldDef | undefined {
  return FIELDS.find((f) => f.key === key);
}
