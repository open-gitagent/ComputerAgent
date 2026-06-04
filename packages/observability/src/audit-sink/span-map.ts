import { SpanStatusCode, type Attributes, type Span } from "@opentelemetry/api";
import { ERROR_TYPE } from "../semantic/attributes.js";

/**
 * In-flight registry of OTel spans that an OtelAuditSink has opened but not
 * yet closed. The harness's session lifecycle drives open/close — the map
 * just keeps the references straight across event ordering, retries, and
 * abrupt terminations.
 *
 * Three span shapes per session:
 *   - invoke_agent: at most one open per session (the session-scoped trace root).
 *   - chat: at most one open per session at a time (LLM call in progress).
 *   - execute_tool: any number open in parallel (tool calls), keyed by callId.
 *
 * Tool correlation strategy (two-level lookup):
 *   1. Primary: (sessionId, callId) exact match — works for claude-agent-sdk,
 *      where the permission callId === the tool_use_id in sdk_message.
 *   2. Fallback: oldest open execute_tool whose `toolName` matches. Covers
 *      the gitagent case where callId/tool_use_id come from independent
 *      generators inside gitclaw's adapter.
 *
 * Both levels of lookup live on `endTool` so the call site doesn't have to
 * branch on the engine.
 */
export class SpanMap {
  private readonly perSession = new Map<string, SessionEntry>();

  // ---------- invoke_agent (per-turn root) ----------

  setInvokeAgent(sessionId: string, span: Span): void {
    const entry = this.getOrCreate(sessionId);
    entry.invokeAgent = span;
  }

  getInvokeAgent(sessionId: string): Span | undefined {
    return this.perSession.get(sessionId)?.invokeAgent;
  }

  endInvokeAgent(sessionId: string, opts: EndOptions = {}): void {
    const entry = this.perSession.get(sessionId);
    if (!entry?.invokeAgent) return;
    finalize(entry.invokeAgent, opts);
    entry.invokeAgent = undefined;
  }

  // ---------- chat (LLM call) ----------

  openChat(sessionId: string, span: Span): void {
    const entry = this.getOrCreate(sessionId);
    // Defensive: if a prior chat was left open (shouldn't happen but engines
    // can be exotic), close it before overwriting so it doesn't leak.
    if (entry.chat) finalize(entry.chat, { status: "ok" });
    entry.chat = span;
  }

  getCurrentChat(sessionId: string): Span | undefined {
    return this.perSession.get(sessionId)?.chat;
  }

  endChat(sessionId: string, opts: EndOptions = {}): void {
    const entry = this.perSession.get(sessionId);
    if (!entry?.chat) return;
    finalize(entry.chat, opts);
    entry.chat = undefined;
  }

  // ---------- execute_tool ----------

  openTool(sessionId: string, callId: string, toolName: string, span: Span): void {
    const entry = this.getOrCreate(sessionId);
    entry.tools.set(callId, { span, toolName, openedAt: Date.now() });
  }

  getTool(sessionId: string, callId: string): Span | undefined {
    return this.perSession.get(sessionId)?.tools.get(callId)?.span;
  }

  /**
   * Close the tool span keyed by `callId`. If no exact match exists and
   * `toolName` is supplied, falls back to the oldest open tool span with
   * the same `toolName` in the session. Returns whether anything was closed.
   */
  endTool(
    sessionId: string,
    callId: string,
    opts: EndOptions = {},
    toolName?: string,
  ): boolean {
    const entry = this.perSession.get(sessionId);
    if (!entry) return false;
    const direct = entry.tools.get(callId);
    if (direct) {
      finalize(direct.span, opts);
      entry.tools.delete(callId);
      return true;
    }
    if (!toolName) return false;
    // Fallback: oldest open tool with matching name.
    let oldestKey: string | undefined;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [k, rec] of entry.tools) {
      if (rec.toolName === toolName && rec.openedAt < oldestAt) {
        oldestAt = rec.openedAt;
        oldestKey = k;
      }
    }
    if (oldestKey === undefined) return false;
    const fallback = entry.tools.get(oldestKey)!;
    finalize(fallback.span, opts);
    entry.tools.delete(oldestKey);
    return true;
  }

  /**
   * Close the chat + tool spans for a TURN boundary, leaving the per-session
   * `invoke_agent` root open. Used on `ca_turn_started` so the next turn starts
   * with a clean chat/tool slate while every turn stays inside the SAME session
   * trace (the single invoke_agent root spans the whole conversation). Keeps the
   * session entry alive.
   */
  endChatAndTools(sessionId: string, opts: EndOptions): void {
    const entry = this.perSession.get(sessionId);
    if (!entry) return;
    for (const [, rec] of entry.tools) finalize(rec.span, opts);
    entry.tools.clear();
    if (entry.chat) {
      finalize(entry.chat, opts);
      entry.chat = undefined;
    }
  }

  /**
   * Force-close every span still open for `sessionId`. Used on
   * `ca_session_ended` (especially error / cancel / budget_exceeded) so we
   * never leak open spans into the exporter.
   *
   * Order of closure: tool spans first (children), then chat, then
   * invoke_agent (root) — so parent-child relationships flush in the order
   * the SDK expects.
   */
  endAllForSession(sessionId: string, opts: EndOptions): void {
    const entry = this.perSession.get(sessionId);
    if (!entry) return;
    for (const [, rec] of entry.tools) finalize(rec.span, opts);
    entry.tools.clear();
    if (entry.chat) {
      finalize(entry.chat, opts);
      entry.chat = undefined;
    }
    if (entry.invokeAgent) {
      finalize(entry.invokeAgent, opts);
      entry.invokeAgent = undefined;
    }
    this.perSession.delete(sessionId);
  }

  /** Total number of open spans across all sessions — for tests. */
  openSpanCount(): number {
    let n = 0;
    for (const e of this.perSession.values()) {
      if (e.invokeAgent) n++;
      if (e.chat) n++;
      n += e.tools.size;
    }
    return n;
  }

  // ---------- internal ----------

  private getOrCreate(sessionId: string): SessionEntry {
    let entry = this.perSession.get(sessionId);
    if (!entry) {
      entry = { tools: new Map() };
      this.perSession.set(sessionId, entry);
    }
    return entry;
  }
}

interface SessionEntry {
  invokeAgent?: Span;
  chat?: Span;
  /** keyed by callId */
  tools: Map<string, { span: Span; toolName: string; openedAt: number }>;
}

export interface EndOptions {
  /** OTel status to set before the span ends. Defaults to OK. */
  status?: "ok" | "error";
  /** Value for `error.type`. Set only when status === "error". */
  errorType?: string;
  /** Optional human-readable error message. */
  errorMessage?: string;
  /** Extra attributes to set immediately before closing. */
  attributes?: Attributes;
}

function finalize(span: Span, opts: EndOptions): void {
  if (opts.attributes) span.setAttributes(opts.attributes);
  if (opts.status === "error") {
    if (opts.errorType) span.setAttribute(ERROR_TYPE, opts.errorType);
    span.setStatus({ code: SpanStatusCode.ERROR, message: opts.errorMessage });
  } else {
    span.setStatus({ code: SpanStatusCode.OK });
  }
  span.end();
}
