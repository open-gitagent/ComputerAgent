import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { metrics, trace, context } from "@opentelemetry/api";
import {
  NodeTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-node";
import { MeterProvider } from "@opentelemetry/sdk-metrics";
import type { AuditRecord } from "@computeragent/harness-server";
import type { HarnessEvent } from "@open-gitagent/protocol";
import { OtelAuditSink } from "./otel-audit-sink.js";
import { GEN_AI_CONVERSATION_ID, GEN_AI_TOOL_NAME, GenAiOperationName } from "../semantic/attributes.js";

/**
 * Phase 3 — verifies the new protocol events drive the right span lifecycle:
 *   - ca_turn_started opens a fresh per-turn invoke_agent (and starts a new trace)
 *   - ca_permission_decision = "deny" closes the pending execute_tool span
 *     with error.type = "permission_denied"
 *   - ca_permission_decision = "allow" leaves the tool span open until tool_result
 *
 * Multi-turn assertion: two turns under the same session produce two SEPARATE
 * traces, joined only by `gen_ai.conversation.id = sessionId`.
 */

let spanExporter: InMemorySpanExporter;
let tracerProvider: NodeTracerProvider;
let meterProvider: MeterProvider;

beforeEach(() => {
  spanExporter = new InMemorySpanExporter();
  tracerProvider = new NodeTracerProvider();
  tracerProvider.addSpanProcessor(new SimpleSpanProcessor(spanExporter));
  tracerProvider.register();
  meterProvider = new MeterProvider();
  metrics.setGlobalMeterProvider(meterProvider);
});

afterEach(async () => {
  await tracerProvider.shutdown();
  await meterProvider.shutdown();
  trace.disable();
  metrics.disable();
  context.disable();
});

const SESSION_ID = "sess-phase3";

function rec(event: HarnessEvent, eventId = 0): AuditRecord {
  return { sessionId: SESSION_ID, eventId, event, timestamp: Date.now() };
}

const baseSessionStarted: Extract<HarnessEvent, { kind: "ca_session_started" }> = {
  kind: "ca_session_started",
  sessionId: SESSION_ID,
  engine: "claude-agent-sdk",
  identity: { name: "haiku-bot", version: "0.1.0", sha: "cafef00d" },
  capabilities: {
    streamingInput: true,
    partialMessages: true,
    permissionCallback: true,
    sessions: true,
    budget: true,
  },
};

const systemInit: Extract<HarnessEvent, { kind: "sdk_message" }> = {
  kind: "sdk_message",
  sessionId: SESSION_ID,
  payload: { type: "system", subtype: "init", model: "claude-haiku-4-5-20251001" },
};

function findByName(spans: ReadableSpan[], name: string): ReadableSpan[] {
  return spans.filter((s) => s.name === name);
}

describe("ca_turn_started drives per-turn invoke_agent roots", () => {
  it("opens invoke_agent on ca_turn_started, not ca_session_started", () => {
    const sink = new OtelAuditSink();
    sink.onEvent(rec(baseSessionStarted));
    // After session_started ONLY, no spans should be finished yet (lazy opening).
    expect(spanExporter.getFinishedSpans()).toEqual([]);

    sink.onEvent(rec({ kind: "ca_turn_started", sessionId: SESSION_ID, turnIndex: 0 }));
    sink.onEvent(rec(systemInit));
    sink.onEvent(
      rec({
        kind: "sdk_message",
        sessionId: SESSION_ID,
        payload: {
          type: "assistant",
          message: { model: "claude-haiku-4-5-20251001", content: [{ type: "text", text: "Done." }] },
        },
      }),
    );
    sink.onEvent(
      rec({
        kind: "sdk_message",
        sessionId: SESSION_ID,
        payload: { type: "result", subtype: "success", model: "claude-haiku-4-5-20251001", stop_reason: "end_turn" },
      }),
    );
    sink.onEvent(rec({ kind: "ca_session_ended", sessionId: SESSION_ID, reason: "complete" }));

    const spans = spanExporter.getFinishedSpans();
    expect(findByName(spans, "invoke_agent haiku-bot")).toHaveLength(1);
    expect(findByName(spans, "chat claude-haiku-4-5-20251001")).toHaveLength(1);
  });

  it("two turns produce two SEPARATE traces, joined by gen_ai.conversation.id", () => {
    const sink = new OtelAuditSink();
    // turn 0
    sink.onEvent(rec(baseSessionStarted));
    sink.onEvent(rec({ kind: "ca_turn_started", sessionId: SESSION_ID, turnIndex: 0 }));
    sink.onEvent(rec(systemInit));
    sink.onEvent(
      rec({
        kind: "sdk_message",
        sessionId: SESSION_ID,
        payload: {
          type: "assistant",
          message: { model: "claude-haiku-4-5-20251001", content: [{ type: "text", text: "turn 0" }] },
        },
      }),
    );
    sink.onEvent(
      rec({
        kind: "sdk_message",
        sessionId: SESSION_ID,
        payload: { type: "result", subtype: "success", model: "claude-haiku-4-5-20251001", stop_reason: "end_turn" },
      }),
    );

    // turn 1 — same session, new turn
    sink.onEvent(rec({ kind: "ca_turn_started", sessionId: SESSION_ID, turnIndex: 1 }));
    sink.onEvent(
      rec({
        kind: "sdk_message",
        sessionId: SESSION_ID,
        payload: {
          type: "assistant",
          message: { model: "claude-haiku-4-5-20251001", content: [{ type: "text", text: "turn 1" }] },
        },
      }),
    );
    sink.onEvent(
      rec({
        kind: "sdk_message",
        sessionId: SESSION_ID,
        payload: { type: "result", subtype: "success", model: "claude-haiku-4-5-20251001", stop_reason: "end_turn" },
      }),
    );
    sink.onEvent(rec({ kind: "ca_session_ended", sessionId: SESSION_ID, reason: "complete" }));

    const spans = spanExporter.getFinishedSpans();
    const agents = findByName(spans, "invoke_agent haiku-bot");
    expect(agents).toHaveLength(2);
    // Same conversation id on both.
    expect(agents[0]!.attributes[GEN_AI_CONVERSATION_ID]).toBe(SESSION_ID);
    expect(agents[1]!.attributes[GEN_AI_CONVERSATION_ID]).toBe(SESSION_ID);
    // DIFFERENT trace ids — the spec uses correlation, not parent-child.
    expect(agents[0]!.spanContext().traceId).not.toBe(agents[1]!.spanContext().traceId);
  });
});

describe("ca_permission_decision closes execute_tool on deny", () => {
  it("closes the tool span with error.type=permission_denied on deny", () => {
    const sink = new OtelAuditSink();
    sink.onEvent(rec(baseSessionStarted));
    sink.onEvent(rec({ kind: "ca_turn_started", sessionId: SESSION_ID, turnIndex: 0 }));
    sink.onEvent(rec(systemInit));
    sink.onEvent(
      rec({
        kind: "ca_permission_request",
        sessionId: SESSION_ID,
        callId: "call-deny-1",
        toolName: "Bash",
        input: { cmd: "rm -rf /" },
        risk: "destructive",
      }),
    );
    sink.onEvent(
      rec({
        kind: "ca_permission_decision",
        sessionId: SESSION_ID,
        callId: "call-deny-1",
        decision: "deny",
        reason: "destructive command",
      }),
    );
    sink.onEvent(
      rec({
        kind: "sdk_message",
        sessionId: SESSION_ID,
        payload: { type: "result", subtype: "success", stop_reason: "end_turn" },
      }),
    );
    sink.onEvent(rec({ kind: "ca_session_ended", sessionId: SESSION_ID, reason: "complete" }));

    const spans = spanExporter.getFinishedSpans();
    const tools = findByName(spans, "execute_tool Bash");
    expect(tools).toHaveLength(1);
    const tool = tools[0]!;
    expect(tool.attributes[GEN_AI_TOOL_NAME]).toBe("Bash");
    expect(tool.attributes["gen_ai.operation.name"]).toBe(GenAiOperationName.EXECUTE_TOOL);
    expect(tool.attributes["error.type"]).toBe("permission_denied");
    // SpanStatusCode.ERROR === 2
    expect(tool.status.code).toBe(2);
    expect(tool.status.message).toBe("destructive command");
  });

  it("leaves the tool span open on allow — closed by tool_result as normal", () => {
    const sink = new OtelAuditSink();
    sink.onEvent(rec(baseSessionStarted));
    sink.onEvent(rec({ kind: "ca_turn_started", sessionId: SESSION_ID, turnIndex: 0 }));
    sink.onEvent(rec(systemInit));
    sink.onEvent(
      rec({
        kind: "ca_permission_request",
        sessionId: SESSION_ID,
        callId: "call-allow-1",
        toolName: "Write",
        input: { path: "x.txt" },
      }),
    );
    sink.onEvent(
      rec({
        kind: "ca_permission_decision",
        sessionId: SESSION_ID,
        callId: "call-allow-1",
        decision: "allow",
      }),
    );

    // Tool span should still be open at this point. Now feed the tool_result.
    expect(findByName(spanExporter.getFinishedSpans(), "execute_tool Write")).toHaveLength(0);

    sink.onEvent(
      rec({
        kind: "sdk_message",
        sessionId: SESSION_ID,
        payload: {
          type: "user",
          message: { content: [{ type: "tool_result", tool_use_id: "call-allow-1", content: "ok" }] },
        },
      }),
    );
    sink.onEvent(
      rec({
        kind: "sdk_message",
        sessionId: SESSION_ID,
        payload: { type: "result", subtype: "success", stop_reason: "end_turn" },
      }),
    );
    sink.onEvent(rec({ kind: "ca_session_ended", sessionId: SESSION_ID, reason: "complete" }));

    const spans = spanExporter.getFinishedSpans();
    const tools = findByName(spans, "execute_tool Write");
    expect(tools).toHaveLength(1);
    // SpanStatusCode.OK === 1; on a clean tool_result we end with OK.
    expect(tools[0]!.status.code).toBe(1);
    expect(tools[0]!.attributes["error.type"]).toBeUndefined();
  });
});
