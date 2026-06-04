import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { metrics, trace, context } from "@opentelemetry/api";
import {
  NodeTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-node";
import type { AuditRecord } from "@computeragent/harness-server";
import type { HarnessEvent } from "@open-gitagent/protocol";
import { OtelAuditSink } from "./otel-audit-sink.js";
import { configure, shutdown } from "../provider.js";
import {
  GEN_AI_INPUT_MESSAGES,
  GEN_AI_OUTPUT_MESSAGES,
  GEN_AI_TOOL_CALL_ARGUMENTS,
  GEN_AI_TOOL_CALL_RESULT,
} from "../semantic/attributes.js";

/**
 * Proves content capture actually works when COMPUTERAGENT_CAPTURE_CONTENT is
 * on — i.e. when `configure({ captureContent: true, captureContentMode:
 * "attributes" })` has run (which is exactly what the server entrypoints now do
 * from the env var). Mirrors the "off by default" assertion in
 * otel-audit-sink.test.ts.
 *
 * Setup trick: register an InMemory tracer provider FIRST (becomes the global
 * tracer), THEN call configure() with exporter:"custom" — its own register()
 * no-ops (global already set), but it installs the frozen config the sink reads
 * via getConfig(), so captureContent flips on while spans still land in-memory.
 */

let spanExporter: InMemorySpanExporter;
let tracerProvider: NodeTracerProvider;

beforeEach(() => {
  spanExporter = new InMemorySpanExporter();
  tracerProvider = new NodeTracerProvider();
  tracerProvider.addSpanProcessor(new SimpleSpanProcessor(spanExporter));
  tracerProvider.register();
  configure({
    serviceName: "capture-test",
    exporter: "custom",
    captureContent: true,
    captureContentMode: "attributes",
  });
});

afterEach(async () => {
  await shutdown();
  await tracerProvider.shutdown();
  trace.disable();
  metrics.disable();
  context.disable();
});

const SESSION_ID = "sess-capture";
function rec(event: HarnessEvent): AuditRecord {
  return { sessionId: SESSION_ID, eventId: 0, event, timestamp: Date.now() };
}
function spanByName(spans: ReadableSpan[], name: string): ReadableSpan | undefined {
  return spans.find((s) => s.name === name);
}

describe("OtelAuditSink — content capture ON (attributes mode)", () => {
  it("stamps input/output messages and tool call args+result on the spans", () => {
    const sink = new OtelAuditSink();

    sink.onEvent(
      rec({
        kind: "ca_session_started",
        sessionId: SESSION_ID,
        engine: "claude-agent-sdk",
        identity: { name: "haiku-bot", version: "0.1.0" },
        capabilities: {
          streamingInput: true,
          partialMessages: true,
          permissionCallback: true,
          sessions: true,
          budget: true,
        },
      }),
    );
    // The turn's triggering user message rides on ca_turn_started — the
    // canonical source of gen_ai.input.messages (the engine never echoes it).
    sink.onEvent(
      rec({
        kind: "ca_turn_started",
        sessionId: SESSION_ID,
        turnIndex: 0,
        message: { role: "user", content: "read haiku.txt" },
      }),
    );
    sink.onEvent(
      rec({
        kind: "sdk_message",
        sessionId: SESSION_ID,
        payload: { type: "system", subtype: "init", model: "claude-haiku-4-5-20251001" },
      }),
    );
    // assistant decides to call a tool
    sink.onEvent(
      rec({
        kind: "sdk_message",
        sessionId: SESSION_ID,
        payload: {
          type: "assistant",
          message: {
            model: "claude-haiku-4-5-20251001",
            content: [{ type: "tool_use", id: "call-1", name: "Read", input: { path: "haiku.txt" } }],
          },
        },
      }),
    );
    // tool result
    sink.onEvent(
      rec({
        kind: "sdk_message",
        sessionId: SESSION_ID,
        payload: {
          type: "user",
          message: { content: [{ type: "tool_result", tool_use_id: "call-1", content: "roses are red" }] },
        },
      }),
    );
    // assistant final answer
    sink.onEvent(
      rec({
        kind: "sdk_message",
        sessionId: SESSION_ID,
        payload: {
          type: "assistant",
          message: { model: "claude-haiku-4-5-20251001", content: [{ type: "text", text: "The file says: roses are red" }] },
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

    // chat span carries the conversation content.
    const chat = spanByName(spans, "chat claude-haiku-4-5-20251001")!;
    expect(chat).toBeDefined();
    const input = String(chat.attributes[GEN_AI_INPUT_MESSAGES] ?? "");
    const output = String(chat.attributes[GEN_AI_OUTPUT_MESSAGES] ?? "");
    expect(input).toContain("read haiku.txt"); // user prompt captured
    expect(output).toContain("roses are red"); // assistant answer captured

    // execute_tool span carries both the tool call args and its result.
    const tool = spanByName(spans, "execute_tool Read")!;
    expect(tool).toBeDefined();
    expect(String(tool.attributes[GEN_AI_TOOL_CALL_ARGUMENTS] ?? "")).toContain("haiku.txt");
    expect(String(tool.attributes[GEN_AI_TOOL_CALL_RESULT] ?? "")).toContain("roses are red");
  });
});
