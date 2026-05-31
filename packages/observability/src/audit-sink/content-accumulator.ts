import type {
  AnthropicBlock,
  SpecInputMessage,
  SpecOutputMessage,
  SpecPart,
  SpecSystemInstructions,
} from "./content-capture.js";
import { blocksToParts, mapStopReasonToFinishReason, textToParts } from "./content-capture.js";

/**
 * Per-session state for content capture. The OtelAuditSink feeds it as
 * sdk_message events arrive; at turn boundaries it dumps accumulated
 * messages onto spans / log events via the content-capture helpers.
 *
 * Separate from `SpanMap` to keep the span lifecycle clean — this class
 * only knows about CONTENT (the prompt/response data); SpanMap only knows
 * about span identity.
 *
 * Reset semantics:
 *   - `reset(sessionId)` clears input/output/system for that session.
 *   - tool-call args/results are keyed by callId and survive turn resets
 *     until consumed by the execute_tool span (or session end).
 */
export class ContentAccumulator {
  private readonly perSession = new Map<string, SessionContent>();
  /** keyed by callId — values consumed once and removed. */
  private readonly toolArgs = new Map<string, unknown>();
  private readonly toolResults = new Map<string, unknown>();

  // ----- input (user → model) -----

  recordUserText(sessionId: string, text: string): void {
    if (!text) return;
    this.getOrCreate(sessionId).input.push({ role: "user", parts: textToParts(text) });
  }

  recordUserBlocks(sessionId: string, blocks: ReadonlyArray<AnthropicBlock>): void {
    // Filter: a user message that's ENTIRELY tool_results isn't a "user
    // message" in the prompt sense — it's the model's tool plumbing. We
    // skip those for input.messages and record results separately.
    const nonResultBlocks = blocks.filter((b) => b.type !== "tool_result");
    if (nonResultBlocks.length === 0) return;
    const parts = blocksToParts(nonResultBlocks);
    if (parts.length === 0) return;
    this.getOrCreate(sessionId).input.push({ role: "user", parts });
  }

  // ----- output (model → user) -----

  /**
   * Build a SpecOutputMessage with the REQUIRED finish_reason field. We
   * normalise Anthropic `stop_reason` strings to the spec enum
   * (`stop|length|content_filter|tool_call|error`). When stop_reason is
   * absent (e.g. intermediate streaming chunk we synthesise from), default
   * to "stop" — never omit the field, the spec rejects messages without it.
   */
  recordAssistantBlocks(
    sessionId: string,
    blocks: ReadonlyArray<AnthropicBlock>,
    anthropicStopReason?: string,
  ): void {
    const parts = blocksToParts(blocks);
    if (parts.length === 0) return;
    // Pass `parts` into the mapper so it can infer `tool_call` when
    // stop_reason is missing but the message clearly contains a tool call.
    const finishReason = mapStopReasonToFinishReason(anthropicStopReason, parts);
    this.getOrCreate(sessionId).output.push({
      role: "assistant",
      parts,
      finish_reason: finishReason,
    });
  }

  // ----- system instructions -----

  /**
   * Append text to the system instructions. Spec-wise these are PARTS
   * (no role wrapper) attached to `gen_ai.system_instructions`. Today the
   * harness doesn't surface SOUL.md / system prompts on the wire, so this
   * method exists for the protocol-extension follow-up and tests.
   */
  recordSystemInstructions(sessionId: string, text: string): void {
    if (!text) return;
    this.getOrCreate(sessionId).system.push({ type: "text", content: text });
  }

  // ----- tool-call content (by callId) -----

  recordToolArgs(callId: string, args: unknown): void {
    this.toolArgs.set(callId, args);
  }

  recordToolResult(callId: string, result: unknown): void {
    this.toolResults.set(callId, result);
  }

  takeToolArgs(callId: string): unknown {
    const v = this.toolArgs.get(callId);
    this.toolArgs.delete(callId);
    return v;
  }

  takeToolResult(callId: string): unknown {
    const v = this.toolResults.get(callId);
    this.toolResults.delete(callId);
    return v;
  }

  // ----- read snapshots (non-destructive) -----

  inputFor(sessionId: string): ReadonlyArray<SpecInputMessage> {
    return this.perSession.get(sessionId)?.input ?? [];
  }

  outputFor(sessionId: string): ReadonlyArray<SpecOutputMessage> {
    return this.perSession.get(sessionId)?.output ?? [];
  }

  systemFor(sessionId: string): SpecSystemInstructions {
    return this.perSession.get(sessionId)?.system ?? [];
  }

  // ----- reset -----

  /** Clear input/output/system accumulators for a session (e.g. on turn boundary or session end). */
  reset(sessionId: string): void {
    this.perSession.delete(sessionId);
  }

  /** For tests. */
  knownToolCallIds(): string[] {
    return [...new Set([...this.toolArgs.keys(), ...this.toolResults.keys()])];
  }

  // ----- internal -----

  private getOrCreate(sessionId: string): SessionContent {
    let s = this.perSession.get(sessionId);
    if (!s) {
      s = { input: [], output: [], system: [] };
      this.perSession.set(sessionId, s);
    }
    return s;
  }
}

interface SessionContent {
  input: SpecInputMessage[];
  output: SpecOutputMessage[];
  system: SpecPart[];
}
