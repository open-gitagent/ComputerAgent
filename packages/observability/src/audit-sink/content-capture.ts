/**
 * Content-capture helpers: normalise Anthropic content-block messages into
 * the OpenTelemetry GenAI `{role, parts}` schema, then either stamp them
 * on a span as JSON-string attributes or emit them as a
 * `gen_ai.client.inference.operation.details` log event.
 *
 * Pure functions — no state, no side-effects beyond writing to the supplied
 * span / logger. The ContentAccumulator owns per-session state and calls
 * these at turn boundaries.
 *
 * Spec compliance — VERBATIM from the official JSON schemas:
 *   https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-input-messages.json
 *   https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-output-messages.json
 *
 *   - `tool_call_response` parts use `response` (NOT `result`)
 *   - the reasoning/thinking part type is `reasoning` (NOT `thinking`)
 *   - output messages REQUIRE `finish_reason` ∈
 *     {stop, length, content_filter, tool_call, error}
 *   - `gen_ai.system_instructions` is an array of PARTS, no role wrapper
 */

import type { Attributes, Span } from "@opentelemetry/api";
import {
  type Logger as OtelLogger,
  type AnyValue,
  SeverityNumber,
} from "@opentelemetry/api-logs";
import {
  GEN_AI_INPUT_MESSAGES,
  GEN_AI_OUTPUT_MESSAGES,
  GEN_AI_SYSTEM_INSTRUCTIONS,
  GEN_AI_TOOL_CALL_ARGUMENTS,
  GEN_AI_TOOL_CALL_RESULT,
  EVENT_GEN_AI_CLIENT_INFERENCE_OPERATION_DETAILS,
} from "../semantic/attributes.js";
import type { CaptureContentMode, TracerConfig } from "../config.js";
import { applyRedaction } from "../redaction.js";

// ---------------------------------------------------------------------------
// Spec types — DO NOT rename fields. Backends parse these keys verbatim.
// ---------------------------------------------------------------------------

export type SpecRole = "user" | "assistant" | "system" | "tool";

/** Spec `finish_reason` enum (output messages only). */
export type SpecFinishReason = "stop" | "length" | "content_filter" | "tool_call" | "error";

/** Discriminated union of message parts allowed by the input/output schemas. */
export type SpecPart =
  | { type: "text"; content: string }
  | { type: "tool_call"; name: string; id?: string; arguments?: unknown }
  | { type: "tool_call_response"; response: unknown; id?: string }
  | { type: "reasoning"; content: string };

/** Input message — no finish_reason. */
export interface SpecInputMessage {
  role: SpecRole;
  parts: SpecPart[];
}

/** Output message — finish_reason is REQUIRED per spec. */
export interface SpecOutputMessage {
  role: SpecRole;
  parts: SpecPart[];
  finish_reason: SpecFinishReason;
}

/**
 * gen_ai.system_instructions is an ARRAY OF PARTS directly (no role wrapper).
 * Spec example: `[{type: "text", content: "..."}, ...]`.
 */
export type SpecSystemInstructions = SpecPart[];

// ---------------------------------------------------------------------------
// Anthropic content block shape (what we get on the wire via sdk_message)
// ---------------------------------------------------------------------------

export interface AnthropicBlock {
  readonly type?: string;
  readonly text?: string;
  readonly thinking?: string;
  readonly id?: string;
  readonly name?: string;
  readonly input?: unknown;
  readonly tool_use_id?: string;
  readonly content?: unknown;
}

/**
 * Anthropic `stop_reason` strings observed in claude-agent-sdk SDKResultMessage
 * and SDKAssistantMessage payloads. We normalise these to the spec's enum.
 *
 * When `stopReason` is undefined (Anthropic frequently omits it on streaming
 * assistant chunks emitted under `includePartialMessages: true`) and the
 * assistant message contains a `tool_call` part, we infer `tool_call` —
 * because by definition the model is calling a tool, which is the spec-
 * defined trigger for that finish_reason. Without this inference, every
 * intermediate tool-call message labels itself "stop" even though the
 * conversation isn't stopping at all.
 */
export function mapStopReasonToFinishReason(
  stopReason: string | undefined,
  parts?: ReadonlyArray<SpecPart>,
): SpecFinishReason {
  switch (stopReason) {
    case "end_turn":
    case "stop_sequence":
    case "pause_turn":
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool_call";
    case "refusal":
      return "content_filter";
    default:
      // No explicit stop_reason — infer from the message contents. A
      // message containing a tool_call part is, by spec definition, ending
      // with the model invoking a tool: finish_reason = "tool_call".
      if (parts && parts.some((p) => p.type === "tool_call")) return "tool_call";
      // Everything else (reasoning-only, text-only) defaults to "stop".
      // The spec requires the field to be set; "stop" is the least
      // misleading option for a normal output we don't have richer info on.
      return "stop";
  }
}

// ---------------------------------------------------------------------------
// Block → Part normaliser
// ---------------------------------------------------------------------------

/**
 * Convert one Anthropic content block to a SpecPart. Returns `undefined` for
 * block types we don't recognise (the caller filters those out).
 *
 * Field renames vs Anthropic:
 *   - `tool_use`  → `{type: "tool_call",          id, name, arguments}`
 *   - `tool_result` → `{type: "tool_call_response", id, response}`
 *   - `thinking`  → `{type: "reasoning",          content}`
 */
export function blockToPart(block: AnthropicBlock): SpecPart | undefined {
  switch (block.type) {
    case "text":
      return typeof block.text === "string" ? { type: "text", content: block.text } : undefined;
    case "thinking":
      return typeof block.thinking === "string"
        ? { type: "reasoning", content: block.thinking }
        : undefined;
    case "tool_use":
      if (typeof block.name === "string") {
        const part: Extract<SpecPart, { type: "tool_call" }> = {
          type: "tool_call",
          name: block.name,
        };
        if (typeof block.id === "string") part.id = block.id;
        if (block.input !== undefined) part.arguments = block.input;
        return part;
      }
      return undefined;
    case "tool_result": {
      const part: Extract<SpecPart, { type: "tool_call_response" }> = {
        type: "tool_call_response",
        response: block.content,
      };
      if (typeof block.tool_use_id === "string") part.id = block.tool_use_id;
      return part;
    }
    default:
      return undefined;
  }
}

/** Build a parts array from a list of Anthropic content blocks. */
export function blocksToParts(blocks: ReadonlyArray<AnthropicBlock> | undefined): SpecPart[] {
  const parts: SpecPart[] = [];
  for (const b of blocks ?? []) {
    const part = blockToPart(b);
    if (part) parts.push(part);
  }
  return parts;
}

/** Single-line text → parts (used when only a plain string is available). */
export function textToParts(text: string): SpecPart[] {
  return [{ type: "text", content: text }];
}

// ---------------------------------------------------------------------------
// Mode helpers
// ---------------------------------------------------------------------------

export function shouldWriteAttribute(mode: CaptureContentMode): boolean {
  return mode === "attributes" || mode === "both";
}

export function shouldEmitEvent(mode: CaptureContentMode): boolean {
  return mode === "events" || mode === "both";
}

// ---------------------------------------------------------------------------
// Truncation + redaction
// ---------------------------------------------------------------------------

/**
 * JSON-encode a value and truncate to `maxBytes` characters. The truncated
 * suffix is `..."[truncated:N]"` with the original length so downstream
 * consumers know they got a clipped value.
 */
export function serializeBounded(value: unknown, maxBytes: number): string {
  const raw = jsonStringifySafe(value);
  if (raw.length <= maxBytes) return raw;
  const head = raw.slice(0, Math.max(0, maxBytes - 32));
  return `${head}..."[truncated:${raw.length}]"`;
}

/** Apply redaction (if enabled) to a single string field. */
export function redactString(input: string, config: TracerConfig): string {
  if (!config.redaction.enabled) return input;
  return applyRedaction(input, config.redaction.replacement);
}

/**
 * Recursively redact string fields inside an arbitrary JSON-shaped value.
 * Returns a fresh copy — never mutates the input.
 */
export function redactAny(value: unknown, config: TracerConfig): unknown {
  if (!config.redaction.enabled) return value;
  if (typeof value === "string") return redactString(value, config);
  if (Array.isArray(value)) return value.map((v) => redactAny(v, config));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactAny(v, config);
    }
    return out;
  }
  return value;
}

/** Redact every string field inside a parts array. */
export function redactParts(parts: SpecPart[], config: TracerConfig): SpecPart[] {
  if (!config.redaction.enabled) return parts;
  return parts.map((p): SpecPart => {
    switch (p.type) {
      case "text":
        return { type: "text", content: redactString(p.content, config) };
      case "reasoning":
        return { type: "reasoning", content: redactString(p.content, config) };
      case "tool_call": {
        const out: Extract<SpecPart, { type: "tool_call" }> = {
          type: "tool_call",
          name: p.name,
        };
        if (p.id !== undefined) out.id = p.id;
        if (p.arguments !== undefined) out.arguments = redactAny(p.arguments, config);
        return out;
      }
      case "tool_call_response": {
        const out: Extract<SpecPart, { type: "tool_call_response" }> = {
          type: "tool_call_response",
          response: redactAny(p.response, config),
        };
        if (p.id !== undefined) out.id = p.id;
        return out;
      }
    }
  });
}

/** Redact every input message's parts. */
export function redactInputMessages(
  messages: SpecInputMessage[],
  config: TracerConfig,
): SpecInputMessage[] {
  if (!config.redaction.enabled) return messages;
  return messages.map((m) => ({ role: m.role, parts: redactParts(m.parts, config) }));
}

/** Redact every output message's parts (preserves finish_reason). */
export function redactOutputMessages(
  messages: SpecOutputMessage[],
  config: TracerConfig,
): SpecOutputMessage[] {
  if (!config.redaction.enabled) return messages;
  return messages.map((m) => ({
    role: m.role,
    parts: redactParts(m.parts, config),
    finish_reason: m.finish_reason,
  }));
}

// ---------------------------------------------------------------------------
// Dispatch — write to span attrs, emit log event, or both
// ---------------------------------------------------------------------------

export interface WriteOptions {
  readonly config: TracerConfig;
  readonly span?: Span;
  readonly logger?: OtelLogger;
  /** Common attributes attached to log events (operation.name, provider, model, conversation, etc.). */
  readonly eventAttributes?: Attributes;
}

/**
 * Write `gen_ai.input.messages` + `gen_ai.output.messages` +
 * `gen_ai.system_instructions` to either the span (attributes mode) and/or
 * a `gen_ai.client.inference.operation.details` log event (events mode).
 *
 * No-op when `captureContent: false`. Empty arrays are NOT written.
 */
export function writeInferenceContent(
  input: SpecInputMessage[] | undefined,
  output: SpecOutputMessage[] | undefined,
  systemInstructions: SpecSystemInstructions | undefined,
  opts: WriteOptions,
): void {
  const { config, span, logger, eventAttributes } = opts;
  if (!config.captureContent) return;

  const redactedInput = input && input.length > 0 ? redactInputMessages(input, config) : undefined;
  const redactedOutput =
    output && output.length > 0 ? redactOutputMessages(output, config) : undefined;
  const redactedSystem =
    systemInstructions && systemInstructions.length > 0
      ? redactParts(systemInstructions, config)
      : undefined;

  if (shouldWriteAttribute(config.captureContentMode) && span) {
    if (redactedInput) {
      span.setAttribute(
        GEN_AI_INPUT_MESSAGES,
        serializeBounded(redactedInput, config.maxAttributeLength),
      );
    }
    if (redactedOutput) {
      span.setAttribute(
        GEN_AI_OUTPUT_MESSAGES,
        serializeBounded(redactedOutput, config.maxAttributeLength),
      );
    }
    if (redactedSystem) {
      span.setAttribute(
        GEN_AI_SYSTEM_INSTRUCTIONS,
        serializeBounded(redactedSystem, config.maxAttributeLength),
      );
    }
  }

  if (shouldEmitEvent(config.captureContentMode) && logger) {
    const body: Record<string, AnyValue> = {};
    if (redactedInput) body[GEN_AI_INPUT_MESSAGES] = redactedInput as unknown as AnyValue;
    if (redactedOutput) body[GEN_AI_OUTPUT_MESSAGES] = redactedOutput as unknown as AnyValue;
    if (redactedSystem) body[GEN_AI_SYSTEM_INSTRUCTIONS] = redactedSystem as unknown as AnyValue;
    if (Object.keys(body).length === 0) return;
    logger.emit({
      severityNumber: SeverityNumber.INFO,
      severityText: "INFO",
      body,
      attributes: {
        "event.name": EVENT_GEN_AI_CLIENT_INFERENCE_OPERATION_DETAILS,
        ...(eventAttributes ?? {}),
      },
    });
  }
}

/**
 * Write `gen_ai.tool.call.arguments` and/or `gen_ai.tool.call.result` on an
 * `execute_tool` span. Tool-call content is span-attribute-only per spec —
 * it's recorded against the specific span, not the inference event.
 *
 * Note the attribute is named `gen_ai.tool.call.result` (the EXECUTE_TOOL
 * span attribute), distinct from the `tool_call_response.response` field
 * used inside `gen_ai.output.messages` parts. Both refer to the same value;
 * the names diverge by spec.
 */
export function writeToolCallContent(
  args: unknown,
  result: unknown,
  span: Span,
  config: TracerConfig,
): void {
  if (!config.captureContent) return;
  if (args !== undefined) {
    const redacted = redactAny(args, config);
    span.setAttribute(
      GEN_AI_TOOL_CALL_ARGUMENTS,
      serializeBounded(redacted, config.maxAttributeLength),
    );
  }
  if (result !== undefined) {
    const redacted = redactAny(result, config);
    span.setAttribute(
      GEN_AI_TOOL_CALL_RESULT,
      serializeBounded(redacted, config.maxAttributeLength),
    );
  }
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function jsonStringifySafe(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify(String(value));
  }
}
