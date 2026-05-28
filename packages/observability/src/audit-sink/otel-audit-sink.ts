import { SpanKind, context as otelContext, trace, type Attributes, type Span } from "@opentelemetry/api";
import type { AuditSink, AuditRecord } from "@computeragent/harness-server";
import type { HarnessEvent } from "@open-gitagent/protocol";
import { getTracer, getMeter, getLogger, getConfig } from "../provider.js";
import type { TracerConfig } from "../config.js";
import {
  COMPUTERAGENT_ENGINE_NAME,
  GEN_AI_AGENT_ID,
  GEN_AI_AGENT_NAME,
  GEN_AI_AGENT_VERSION,
  GEN_AI_CONVERSATION_ID,
  GEN_AI_OPERATION_NAME,
  GEN_AI_PROVIDER_NAME,
  GEN_AI_REQUEST_MODEL,
  GEN_AI_RESPONSE_FINISH_REASONS,
  GEN_AI_RESPONSE_MODEL,
  GEN_AI_TOOL_CALL_ID,
  GEN_AI_TOOL_NAME,
  GenAiOperationName,
} from "../semantic/attributes.js";
import { SpanMap } from "./span-map.js";
import { UsageAggregator } from "./usage-aggregator.js";
import { ContentAccumulator } from "./content-accumulator.js";
import { writeInferenceContent, writeToolCallContent } from "./content-capture.js";
import {
  parseClaudeSdkMessage,
  extractClaudeContent,
  CLAUDE_SDK_OPERATION_NAME,
  CLAUDE_SDK_PROVIDER_NAME,
  type ClaudeSdkParsed,
} from "./mappers/claude-agent-sdk.js";

/**
 * Implements `@computeragent/harness-server`'s `AuditSink` to emit
 * OpenTelemetry GenAI-semconv-compliant spans + metrics from every
 * `HarnessEvent` the framework tees here.
 *
 * Phase-2 scope: single-turn happy path for the claude-agent-sdk engine.
 *
 *   Trace tree produced per session:
 *
 *     invoke_agent <agent.name>     [gen_ai.conversation.id = sessionId]
 *     └── chat <model>              opened lazily on first sdk_message with model
 *         ├── execute_tool <name>   opened on ca_permission_request / tool_use
 *         └── execute_tool <name>
 *
 * Phase 3 adds: multi-turn (`ca_turn_started`), permission-decision close
 * (`ca_permission_decision`), tool span close on deny.
 *
 * Fire-and-forget contract: never throws into the caller. Any exception in
 * the dispatcher is caught and logged; the session is unaffected.
 */
export class OtelAuditSink implements AuditSink {
  private readonly spans = new SpanMap();
  private readonly usage: UsageAggregator;
  private readonly content = new ContentAccumulator();
  /** Per-session metadata learned from `ca_session_started`. */
  private readonly sessionMeta = new Map<string, SessionMeta>();
  /** Per-session model name (learned from sdk_message system_init). */
  private readonly sessionModel = new Map<string, string>();

  constructor() {
    this.usage = new UsageAggregator(getMeter());
  }

  /** Current frozen config, or a safe default when no `configure()` has run. */
  private cfg(): TracerConfig {
    return getConfig() ?? FALLBACK_CONFIG;
  }

  onEvent(record: AuditRecord): void {
    try {
      this.dispatch(record);
    } catch (err) {
      // Match the AuditSink contract: never propagate to the harness. The
      // session is sacred; observability failures must be invisible.
      if (getConfig() && process.env.COMPUTERAGENT_OBS_DEBUG === "1") {
        // eslint-disable-next-line no-console
        console.error("[otel-audit-sink] dispatcher threw:", err);
      }
    }
  }

  // ---------------------------------------------------------------------
  // Dispatch
  // ---------------------------------------------------------------------

  private dispatch(record: AuditRecord): void {
    const { sessionId, event } = record;
    switch (event.kind) {
      case "ca_session_started":
        this.onSessionStarted(sessionId, event);
        return;
      case "ca_turn_started":
        this.onTurnStarted(sessionId, event);
        return;
      case "ca_permission_request":
        this.onPermissionRequest(sessionId, event);
        return;
      case "ca_permission_decision":
        this.onPermissionDecision(sessionId, event);
        return;
      case "ca_usage_snapshot":
        this.onUsageSnapshot(sessionId, event);
        return;
      case "ca_session_ended":
        this.onSessionEnded(sessionId, event);
        return;
      case "sdk_message":
        this.onSdkMessage(sessionId, event.payload);
        return;
    }
  }

  // ---------------------------------------------------------------------
  // ca_session_started → record metadata (invoke_agent opens on ca_turn_started)
  // ---------------------------------------------------------------------

  private onSessionStarted(
    sessionId: string,
    event: Extract<HarnessEvent, { kind: "ca_session_started" }>,
  ): void {
    const meta: SessionMeta = {
      engineName: event.engine,
      agentName: event.identity.name,
      agentVersion: event.identity.version,
    };
    if (event.identity.sha) meta.agentSha = event.identity.sha;
    this.sessionMeta.set(sessionId, meta);
    // Per OpenTelemetry GenAI semconv, invoke_agent represents the execution
    // of one agent invocation (one user turn), not the session. We open it
    // on `ca_turn_started`. If a backward-compatible client sends no
    // ca_turn_started, the legacy fallback opens it inside ensureInvokeAgent().
  }

  // ---------------------------------------------------------------------
  // ca_turn_started → open a fresh per-turn invoke_agent root
  // ---------------------------------------------------------------------

  private onTurnStarted(
    sessionId: string,
    event: Extract<HarnessEvent, { kind: "ca_turn_started" }>,
  ): void {
    // Close any prior turn's invoke_agent + still-open children.
    // Tokens/cost already flushed to the prior root by usage-snapshot ingest;
    // here we just clean up the in-flight span tree.
    const prior = this.spans.getInvokeAgent(sessionId);
    if (prior) {
      // Stamp running totals on the prior root and close it cleanly. The
      // usage aggregator keeps cumulative state per session — we DO NOT
      // call usage.endSession yet (that happens on ca_session_ended).
      const usageAttrs = this.usage.spanAttributes(sessionId);
      prior.setAttributes(usageAttrs);
      this.spans.endInvokeAgent(sessionId, { status: "ok" });
    }
    // Per-turn lifecycle: each turn starts fresh chat + tool tracking, since
    // those are children of the per-turn root. Flush any leftover children
    // defensively (in practice the engine should have closed them itself).
    this.spans.endAllForSession(sessionId, { status: "ok" });
    // Reset captured content — each turn is a distinct LLM operation and
    // gets its own gen_ai.input.messages / gen_ai.output.messages set.
    this.content.reset(sessionId);
    this.openInvokeAgentForTurn(sessionId);

    // Capture the triggering user message into the accumulator. This is the
    // canonical source of gen_ai.input.messages — engines like claude-agent-sdk
    // do NOT echo the initial prompt back as an sdk_message, so without this
    // path the input content would be permanently missing on every turn.
    if (event.message && this.cfg().captureContent) {
      const content = event.message.content;
      if (typeof content === "string") {
        this.content.recordUserText(sessionId, content);
      } else if (Array.isArray(content)) {
        this.content.recordUserBlocks(sessionId, content as Array<{ readonly type?: string }>);
      }
    }
  }

  private openInvokeAgentForTurn(sessionId: string): void {
    const meta = this.sessionMeta.get(sessionId);
    if (!meta) return;
    const providerName = providerForEngine(meta.engineName);
    const attrs: Attributes = {
      [GEN_AI_OPERATION_NAME]: GenAiOperationName.INVOKE_AGENT,
      [GEN_AI_PROVIDER_NAME]: providerName,
      [GEN_AI_AGENT_NAME]: meta.agentName,
      [GEN_AI_AGENT_VERSION]: meta.agentVersion,
      [GEN_AI_CONVERSATION_ID]: sessionId,
      [COMPUTERAGENT_ENGINE_NAME]: meta.engineName,
    };
    if (meta.agentSha) attrs[GEN_AI_AGENT_ID] = meta.agentSha;
    // Carry forward the model already learned from a previous turn so the
    // span's request model is populated even before the next system_init.
    const model = this.sessionModel.get(sessionId);
    if (model) attrs[GEN_AI_REQUEST_MODEL] = model;

    const span = getTracer().startSpan(`invoke_agent ${meta.agentName}`, {
      kind: SpanKind.CLIENT,
      attributes: attrs,
    });
    this.spans.setInvokeAgent(sessionId, span);
  }

  /**
   * Legacy fallback: ensure an invoke_agent exists for this session, in case
   * an audit producer (older harness, custom client) sends sdk_message events
   * without first emitting ca_turn_started. The session-metadata table is
   * still populated by ca_session_started.
   */
  private ensureInvokeAgent(sessionId: string): void {
    if (this.spans.getInvokeAgent(sessionId)) return;
    if (!this.sessionMeta.has(sessionId)) return;
    this.openInvokeAgentForTurn(sessionId);
  }

  // ---------------------------------------------------------------------
  // ca_permission_request → open execute_tool span
  // ---------------------------------------------------------------------

  private onPermissionRequest(
    sessionId: string,
    event: Extract<HarnessEvent, { kind: "ca_permission_request" }>,
  ): void {
    // If we already opened a tool span (via a tool_use sdk_message racing
    // ahead of the permission request), don't double-open.
    if (this.spans.getTool(sessionId, event.callId)) return;
    this.ensureInvokeAgent(sessionId);
    const parent = this.spans.getCurrentChat(sessionId) ?? this.spans.getInvokeAgent(sessionId);
    const span = this.startToolSpan(sessionId, event.callId, event.toolName, parent);
    this.spans.openTool(sessionId, event.callId, event.toolName, span);
  }

  // ---------------------------------------------------------------------
  // ca_permission_decision → close execute_tool span on deny
  // ---------------------------------------------------------------------

  private onPermissionDecision(
    sessionId: string,
    event: Extract<HarnessEvent, { kind: "ca_permission_decision" }>,
  ): void {
    if (event.decision === "deny") {
      // Capture tool args (no result — the tool never ran) before closing.
      const tool = this.spans.getTool(sessionId, event.callId);
      if (tool) {
        const args = this.content.takeToolArgs(event.callId);
        writeToolCallContent(args, undefined, tool, this.cfg());
      }
      // Close the open tool span with an error status. The matching
      // tool_result will not arrive because the engine never executed the
      // tool — leaving the span open would leak.
      this.spans.endTool(sessionId, event.callId, {
        status: "error",
        errorType: "permission_denied",
        ...(event.reason ? { errorMessage: event.reason } : {}),
      });
      return;
    }
    // For allow/modify, leave the span open — the engine will execute the
    // tool and produce a tool_result, which closes it the normal way.
  }

  // ---------------------------------------------------------------------
  // ca_usage_snapshot → record into UsageAggregator
  // ---------------------------------------------------------------------

  private onUsageSnapshot(
    sessionId: string,
    event: Extract<HarnessEvent, { kind: "ca_usage_snapshot" }>,
  ): void {
    const meta = this.sessionMeta.get(sessionId);
    const providerName = meta ? providerForEngine(meta.engineName) : CLAUDE_SDK_PROVIDER_NAME;
    const requestModel = this.sessionModel.get(sessionId);
    this.usage.ingest(sessionId, event, {
      operationName: CLAUDE_SDK_OPERATION_NAME,
      providerName,
      ...(requestModel ? { requestModel } : {}),
    });
  }

  // ---------------------------------------------------------------------
  // ca_session_ended → flush usage + close everything
  // ---------------------------------------------------------------------

  private onSessionEnded(
    sessionId: string,
    event: Extract<HarnessEvent, { kind: "ca_session_ended" }>,
  ): void {
    // If the chat span is still open (engine errored before turn_result, or
    // ca_session_ended arrived without one), stamp accumulated content now
    // so input/output messages aren't lost on the error path.
    if (this.spans.getCurrentChat(sessionId)) this.writeChatContent(sessionId);

    // Stamp accumulated usage on the chat span (if present) and the
    // invoke_agent (so dashboards filtering on conversation get totals).
    const usageAttrs = this.usage.spanAttributes(sessionId);
    const chat = this.spans.getCurrentChat(sessionId);
    const agent = this.spans.getInvokeAgent(sessionId);
    if (chat) chat.setAttributes(usageAttrs);
    if (agent) agent.setAttributes(usageAttrs);

    const isError = event.reason !== "complete";
    const errorType = isError ? event.reason : undefined;
    const errorMessage = event.errorMessage;

    this.spans.endAllForSession(sessionId, {
      status: isError ? "error" : "ok",
      ...(errorType !== undefined ? { errorType } : {}),
      ...(errorMessage !== undefined ? { errorMessage } : {}),
    });

    const meta = this.sessionMeta.get(sessionId);
    const providerName = meta ? providerForEngine(meta.engineName) : CLAUDE_SDK_PROVIDER_NAME;
    const requestModel = this.sessionModel.get(sessionId);
    this.usage.endSession(
      sessionId,
      {
        operationName: CLAUDE_SDK_OPERATION_NAME,
        providerName,
        ...(requestModel ? { requestModel } : {}),
      },
      errorType,
    );

    this.sessionMeta.delete(sessionId);
    this.sessionModel.delete(sessionId);
    this.content.reset(sessionId);
  }

  // ---------------------------------------------------------------------
  // sdk_message → parse and translate to span operations
  // ---------------------------------------------------------------------

  private onSdkMessage(sessionId: string, payload: unknown): void {
    // Two-pass on every sdk_message:
    //   1. Sub-event dispatch drives span lifecycle (system_init, tool_use,
    //      tool_result, turn_result, etc.).
    //   2. Content extraction feeds the ContentAccumulator with the FULL
    //      assistant/user message so input/output messages keep their
    //      multi-part structure (text + tool_call + thinking in one
    //      SpecMessage).
    const events = parseClaudeSdkMessage(payload);
    for (const ev of events) this.handleSdkSubEvent(sessionId, ev);
    this.captureContentFromSdkMessage(sessionId, payload);
  }

  private captureContentFromSdkMessage(sessionId: string, payload: unknown): void {
    if (!this.cfg().captureContent) return;
    const extracted = extractClaudeContent(payload);
    if (!extracted) return;
    if (extracted.role === "user") {
      // tool_result blocks are recorded against their callId separately;
      // anything else counts as a real user message.
      const userBlocks: Array<(typeof extracted.blocks)[number]> = [];
      for (const block of extracted.blocks) {
        if (block.type === "tool_result" && typeof (block as { tool_use_id?: string }).tool_use_id === "string") {
          this.content.recordToolResult(
            (block as { tool_use_id: string }).tool_use_id,
            (block as { content?: unknown }).content,
          );
        } else {
          userBlocks.push(block);
        }
      }
      if (userBlocks.length > 0) this.content.recordUserBlocks(sessionId, userBlocks);
    } else {
      // assistant
      this.content.recordAssistantBlocks(sessionId, extracted.blocks, extracted.finishReason);
      for (const block of extracted.blocks) {
        if (block.type === "tool_use" && typeof (block as { id?: string }).id === "string") {
          this.content.recordToolArgs(
            (block as { id: string }).id,
            (block as { input?: unknown }).input,
          );
        }
      }
    }
  }

  private handleSdkSubEvent(sessionId: string, ev: ClaudeSdkParsed): void {
    switch (ev.kind) {
      case "system_init":
        if (ev.model) {
          this.sessionModel.set(sessionId, ev.model);
          this.spans.getInvokeAgent(sessionId)?.setAttribute(GEN_AI_REQUEST_MODEL, ev.model);
        }
        return;

      case "assistant_text":
      case "assistant_thinking":
        if (ev.kind === "assistant_text" && ev.model) {
          this.sessionModel.set(sessionId, ev.model);
        }
        this.ensureChatSpan(sessionId);
        return;

      case "tool_use": {
        this.ensureChatSpan(sessionId);
        // If permission gate already opened a span under this callId, leave it.
        if (this.spans.getTool(sessionId, ev.callId)) return;
        const parent = this.spans.getCurrentChat(sessionId) ?? this.spans.getInvokeAgent(sessionId);
        const span = this.startToolSpan(sessionId, ev.callId, ev.toolName, parent);
        this.spans.openTool(sessionId, ev.callId, ev.toolName, span);
        return;
      }

      case "tool_result": {
        // Stamp gen_ai.tool.call.arguments / gen_ai.tool.call.result BEFORE
        // closing the span — once `endTool` returns, the SDK has shipped it.
        const tool = this.spans.getTool(sessionId, ev.callId);
        if (tool) {
          const args = this.content.takeToolArgs(ev.callId);
          const result = this.content.takeToolResult(ev.callId) ?? ev.content;
          writeToolCallContent(args, result, tool, this.cfg());
        }
        this.spans.endTool(sessionId, ev.callId, {
          status: ev.isError ? "error" : "ok",
          ...(ev.isError ? { errorType: "tool_execution_error" as const } : {}),
        });
        return;
      }

      case "turn_result": {
        // Stamp gen_ai.input.messages / gen_ai.output.messages /
        // gen_ai.system_instructions on the chat span BEFORE close. Same
        // ordering rule as tool_result — once endChat returns, the
        // BatchSpanProcessor may have already flushed the span.
        this.writeChatContent(sessionId);
        // End the in-flight chat span. Usage attrs land in onSessionEnded.
        const chatAttrs: Attributes = {};
        if (ev.model) chatAttrs[GEN_AI_RESPONSE_MODEL] = ev.model;
        if (ev.finishReasons) chatAttrs[GEN_AI_RESPONSE_FINISH_REASONS] = ev.finishReasons;
        this.spans.endChat(sessionId, {
          status: ev.isError ? "error" : "ok",
          ...(ev.isError ? { errorType: "engine_error" as const } : {}),
          attributes: chatAttrs,
        });
        return;
      }

      case "unknown":
        // Ignore — unfamiliar message types should not break observability.
        return;
    }
  }

  // ---------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------

  private ensureChatSpan(sessionId: string): void {
    if (this.spans.getCurrentChat(sessionId)) return;
    this.ensureInvokeAgent(sessionId);
    const meta = this.sessionMeta.get(sessionId);
    const providerName = meta ? providerForEngine(meta.engineName) : CLAUDE_SDK_PROVIDER_NAME;
    const model = this.sessionModel.get(sessionId);
    const attrs: Attributes = {
      [GEN_AI_OPERATION_NAME]: GenAiOperationName.CHAT,
      [GEN_AI_PROVIDER_NAME]: providerName,
      [GEN_AI_CONVERSATION_ID]: sessionId,
    };
    if (model) attrs[GEN_AI_REQUEST_MODEL] = model;

    const parent = this.spans.getInvokeAgent(sessionId);
    const ctx = parent ? trace.setSpan(otelContext.active(), parent) : otelContext.active();
    const span = getTracer().startSpan(
      model ? `chat ${model}` : "chat",
      { kind: SpanKind.CLIENT, attributes: attrs },
      ctx,
    );
    this.spans.openChat(sessionId, span);
  }

  /**
   * Stamp `gen_ai.input.messages` / `gen_ai.output.messages` /
   * `gen_ai.system_instructions` on the chat span (and/or emit them as a
   * `gen_ai.client.inference.operation.details` log event) according to
   * the configured `captureContent` + `captureContentMode`.
   *
   * No-op when capture is off or no chat span is open.
   */
  private writeChatContent(sessionId: string): void {
    const config = this.cfg();
    if (!config.captureContent) return;
    const chat = this.spans.getCurrentChat(sessionId);
    if (!chat) return;

    const meta = this.sessionMeta.get(sessionId);
    const providerName = meta ? providerForEngine(meta.engineName) : CLAUDE_SDK_PROVIDER_NAME;
    const requestModel = this.sessionModel.get(sessionId);

    const eventAttributes: Attributes = {
      [GEN_AI_OPERATION_NAME]: GenAiOperationName.CHAT,
      [GEN_AI_PROVIDER_NAME]: providerName,
      [GEN_AI_CONVERSATION_ID]: sessionId,
    };
    if (requestModel) eventAttributes[GEN_AI_REQUEST_MODEL] = requestModel;

    writeInferenceContent(
      [...this.content.inputFor(sessionId)],
      [...this.content.outputFor(sessionId)],
      [...this.content.systemFor(sessionId)],
      {
        config,
        span: chat,
        logger: getLogger(),
        eventAttributes,
      },
    );
  }

  private startToolSpan(
    sessionId: string,
    callId: string,
    toolName: string,
    parent: Span | undefined,
  ): Span {
    const attrs: Attributes = {
      [GEN_AI_OPERATION_NAME]: GenAiOperationName.EXECUTE_TOOL,
      [GEN_AI_TOOL_NAME]: toolName,
      [GEN_AI_TOOL_CALL_ID]: callId,
      [GEN_AI_CONVERSATION_ID]: sessionId,
    };
    const ctx = parent ? trace.setSpan(otelContext.active(), parent) : otelContext.active();
    return getTracer().startSpan(
      `execute_tool ${toolName}`,
      { kind: SpanKind.INTERNAL, attributes: attrs },
      ctx,
    );
  }
}

interface SessionMeta {
  engineName: string;
  agentName: string;
  agentVersion: string;
  agentSha?: string;
}

/**
 * Used when no `configure()` has run yet (e.g. test harness, library use
 * without a configured global). Mirrors `parseTracerConfig({})` defaults
 * but doesn't pull in Zod at hot-path time.
 */
const FALLBACK_CONFIG: TracerConfig = Object.freeze({
  serviceName: "computeragent",
  exporter: "none" as const,
  sampleRate: 1.0,
  captureContent: false,
  captureContentMode: "events" as const,
  maxAttributeLength: 4096,
  metricsEnabled: true,
  metricsExportIntervalMillis: 60_000,
  redaction: Object.freeze({ enabled: false, replacement: "[REDACTED:{kind}]" }),
}) as TracerConfig;

/**
 * Map a ComputerAgent engine name to the underlying GenAI provider name.
 * Both reference engines (`claude-agent-sdk`, `gitagent`) talk to Anthropic.
 * Future engines can extend this — or we make it a registered map.
 */
function providerForEngine(engineName: string): string {
  switch (engineName) {
    case "claude-agent-sdk":
    case "gitagent":
      return CLAUDE_SDK_PROVIDER_NAME;
    default:
      // Pass through. Backends will still treat it as `gen_ai.provider.name`;
      // the OTel spec accepts free-form when not in the enum.
      return engineName;
  }
}

