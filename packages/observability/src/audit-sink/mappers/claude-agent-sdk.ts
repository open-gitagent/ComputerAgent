/**
 * Engine-specific adapter for `sdk_message` payloads produced by
 * `@computeragent/engine-claude-agent-sdk` (which wraps
 * `@anthropic-ai/claude-agent-sdk`).
 *
 * Why this exists: the harness forwards `sdk_message` events as opaque
 * `payload: unknown` so the protocol doesn't squat on engine-native shapes.
 * The OtelAuditSink needs to *interpret* the payload to know whether a new
 * chat span needs opening, a tool span needs closing, etc. Each engine gets
 * its own mapper file — keep the parsing here, not inline in the sink.
 *
 * The payload shape we expect (Anthropic content blocks, forwarded verbatim
 * by the engine):
 *
 *   {type: "assistant", message: {model, content: [
 *     {type: "text", text},
 *     {type: "tool_use", id, name, input},
 *     {type: "thinking", thinking},
 *   ]}}
 *
 *   {type: "user", message: {content: [
 *     {type: "tool_result", tool_use_id, content, is_error?},
 *   ]}}
 *
 *   {type: "result", subtype, total_cost_usd, usage: {...}}
 *
 *   {type: "system", subtype: "init", model, session_id, ...}
 *
 * Anything we can't classify is reported as `{kind: "unknown"}` — the sink
 * logs and ignores. Never throw; engines can ship new message types and we
 * don't want a stray field to take the whole pipeline down.
 */

import type { GenAiOperationName } from "../../semantic/attributes.js";

export type ClaudeSdkParsed =
  | { kind: "system_init"; model?: string; sessionId?: string }
  | { kind: "assistant_text"; text: string; model?: string }
  | { kind: "assistant_thinking"; text: string }
  | { kind: "tool_use"; callId: string; toolName: string; input: unknown; model?: string }
  | { kind: "tool_result"; callId: string; isError: boolean; content: unknown }
  | {
      kind: "turn_result";
      subtype?: string;
      model?: string;
      isError: boolean;
      stopReason?: string;
      finishReasons?: string[];
    }
  | { kind: "unknown"; type?: string };

interface AssistantBlock {
  readonly type?: string;
  readonly text?: string;
  readonly thinking?: string;
  readonly id?: string;
  readonly name?: string;
  readonly input?: unknown;
}

interface UserBlock {
  readonly type?: string;
  readonly tool_use_id?: string;
  readonly content?: unknown;
  readonly is_error?: boolean;
}

interface SdkMessageEnvelope {
  readonly type?: string;
  readonly subtype?: string;
  readonly model?: string;
  readonly session_id?: string;
  readonly stop_reason?: string | null;
  readonly total_cost_usd?: number;
  readonly message?: {
    readonly model?: string;
    readonly stop_reason?: string | null;
    readonly content?: ReadonlyArray<AssistantBlock | UserBlock>;
  };
  readonly is_error?: boolean;
}

/**
 * Parse a single `sdk_message.payload` into the discrete events the sink
 * cares about. Returns an array because one SDKMessage with multiple content
 * blocks (text + tool_use + thinking) maps to multiple events.
 */
export function parseClaudeSdkMessage(payload: unknown): ClaudeSdkParsed[] {
  const m = payload as SdkMessageEnvelope | null;
  if (!m || typeof m !== "object") return [{ kind: "unknown" }];

  switch (m.type) {
    case "system": {
      if (m.subtype === "init") {
        const out: ClaudeSdkParsed = { kind: "system_init" };
        if (m.model) out.model = m.model;
        if (m.session_id) out.sessionId = m.session_id;
        return [out];
      }
      return [{ kind: "unknown", type: `system/${m.subtype ?? "?"}` }];
    }

    case "assistant": {
      const blocks = m.message?.content ?? [];
      const events: ClaudeSdkParsed[] = [];
      const model = m.message?.model;
      for (const block of blocks) {
        const b = block as AssistantBlock;
        if (b.type === "text" && typeof b.text === "string") {
          const ev: Extract<ClaudeSdkParsed, { kind: "assistant_text" }> = {
            kind: "assistant_text",
            text: b.text,
          };
          if (model) ev.model = model;
          events.push(ev);
        } else if (b.type === "thinking" && typeof b.thinking === "string") {
          events.push({ kind: "assistant_thinking", text: b.thinking });
        } else if (b.type === "tool_use" && typeof b.id === "string" && typeof b.name === "string") {
          const ev: Extract<ClaudeSdkParsed, { kind: "tool_use" }> = {
            kind: "tool_use",
            callId: b.id,
            toolName: b.name,
            input: b.input,
          };
          if (model) ev.model = model;
          events.push(ev);
        }
      }
      return events.length > 0 ? events : [{ kind: "unknown", type: "assistant/empty" }];
    }

    case "user": {
      const blocks = m.message?.content ?? [];
      const events: ClaudeSdkParsed[] = [];
      for (const block of blocks) {
        const b = block as UserBlock;
        if (b.type === "tool_result" && typeof b.tool_use_id === "string") {
          events.push({
            kind: "tool_result",
            callId: b.tool_use_id,
            isError: b.is_error === true,
            content: b.content,
          });
        }
      }
      // A user message with no tool_result is just an echo of user input —
      // not interesting for span shaping.
      return events.length > 0 ? events : [{ kind: "unknown", type: "user/echo" }];
    }

    case "result": {
      const isError = m.is_error === true || m.subtype === "error";
      const stopReason = m.message?.stop_reason ?? m.stop_reason ?? undefined;
      const ev: Extract<ClaudeSdkParsed, { kind: "turn_result" }> = {
        kind: "turn_result",
        isError,
      };
      if (m.subtype) ev.subtype = m.subtype;
      if (m.model || m.message?.model) ev.model = m.model ?? m.message?.model;
      if (stopReason) {
        ev.stopReason = stopReason;
        ev.finishReasons = [stopReason];
      }
      return [ev];
    }

    default:
      return [{ kind: "unknown", type: m.type }];
  }
}

/**
 * Operation-name binding used when we open a `chat` span from an
 * `assistant_text` block. Constant — Claude SDK always speaks "chat".
 */
export const CLAUDE_SDK_OPERATION_NAME: GenAiOperationName = "chat";

/** The LLM provider behind this engine, per OTel GenAI spec enum. */
export const CLAUDE_SDK_PROVIDER_NAME = "anthropic" as const;

/**
 * Extract the raw content blocks from an `sdk_message` payload for
 * content-capture purposes (input/output/tool args/result accumulation).
 *
 * Separate from `parseClaudeSdkMessage` because content capture wants the
 * FULL message (one assistant message with text + tool_use blocks together
 * to build one SpecMessage with multiple parts), whereas the sub-event
 * dispatch wants block-level granularity for span lifecycle.
 *
 * Returns `undefined` for non-content messages (system, result, etc.).
 */
export function extractClaudeContent(
  payload: unknown,
): { role: "user" | "assistant"; blocks: ReadonlyArray<AssistantBlock | UserBlock>; finishReason?: string } | undefined {
  const m = payload as SdkMessageEnvelope | null;
  if (!m || typeof m !== "object") return undefined;
  if (m.type !== "assistant" && m.type !== "user") return undefined;
  const blocks = m.message?.content;
  if (!Array.isArray(blocks)) return undefined;
  const stop = m.message?.stop_reason ?? m.stop_reason;
  const out: ReturnType<typeof extractClaudeContent> = {
    role: m.type as "user" | "assistant",
    blocks,
  };
  if (stop) out.finishReason = stop;
  return out;
}
