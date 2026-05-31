// Public surface of @computeragent/observability.
//
// Phase 1 exports: configuration + lifecycle + context + spec constants.
// Phase 2 will add OtelAuditSink + mappers.

export type { TracerConfig, TracerConfigInput, CaptureContentMode, ExporterType } from "./config.js";
export { parseTracerConfig, TracerConfigSchema } from "./config.js";

export { configure, shutdown, getConfig, getTracer, getMeter, getLogger } from "./provider.js";

export { getConversationId, withConversationId, enterConversation } from "./context.js";

export { OtelAuditSink } from "./audit-sink/otel-audit-sink.js";

export * as Semantic from "./semantic/attributes.js";
