import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { context, metrics, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import {
  NodeTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-node";
import { MeterProvider } from "@opentelemetry/sdk-metrics";
import {
  LoggerProvider,
  InMemoryLogRecordExporter,
  SimpleLogRecordProcessor,
  type ReadableLogRecord,
} from "@opentelemetry/sdk-logs";
import type { AuditRecord } from "@computeragent/harness-server";
import type { HarnessEvent } from "@open-gitagent/protocol";
import { configure, shutdown } from "../provider.js";
import { OtelAuditSink } from "./otel-audit-sink.js";
import {
  blockToPart,
  mapStopReasonToFinishReason,
  type SpecOutputMessage,
  type SpecInputMessage,
} from "./content-capture.js";
import { applyRedaction } from "../redaction.js";

/**
 * Phase 5 — content capture. Verifies:
 *   - The Anthropic → spec mapper renames fields correctly (`response` not
 *     `result`, `reasoning` not `thinking`).
 *   - Capture stays OFF by default.
 *   - All three modes (attributes / events / both) emit content.
 *   - `finish_reason` is set on every output message (required by spec).
 *   - Tool args/result land on `execute_tool` span when capture is on.
 *   - Redaction redacts known PII patterns.
 *   - Truncation respects `maxAttributeLength`.
 */

let spanExporter: InMemorySpanExporter;
let logExporter: InMemoryLogRecordExporter;
let tracerProvider: NodeTracerProvider;
let meterProvider: MeterProvider;
let loggerProvider: LoggerProvider;

beforeEach(() => {
  spanExporter = new InMemorySpanExporter();
  tracerProvider = new NodeTracerProvider();
  tracerProvider.addSpanProcessor(new SimpleSpanProcessor(spanExporter));
  tracerProvider.register();

  meterProvider = new MeterProvider();
  metrics.setGlobalMeterProvider(meterProvider);

  logExporter = new InMemoryLogRecordExporter();
  loggerProvider = new LoggerProvider();
  loggerProvider.addLogRecordProcessor(new SimpleLogRecordProcessor(logExporter));
  logs.setGlobalLoggerProvider(loggerProvider);
});

afterEach(async () => {
  await tracerProvider.shutdown();
  await meterProvider.shutdown();
  await loggerProvider.shutdown();
  await shutdown(500);
  trace.disable();
  metrics.disable();
  context.disable();
  logs.disable();
});

const SESSION_ID = "sess-content-test";

function rec(event: HarnessEvent, eventId = 0): AuditRecord {
  return { sessionId: SESSION_ID, eventId, event, timestamp: Date.now() };
}

// Build a synthetic event sequence for one turn that includes user text,
// assistant text + tool_use, tool_result, and a turn_result.
//
// IMPORTANT: claude-agent-sdk does NOT echo the initial user prompt as an
// sdk_message. The user content rides on ca_turn_started.message — that's
// the canonical source the accumulator reads from.
function driveHappyTurn(sink: OtelAuditSink): void {
  sink.onEvent(
    rec({
      kind: "ca_session_started",
      sessionId: SESSION_ID,
      engine: "claude-agent-sdk",
      identity: { name: "haiku-bot", version: "0.1.0", sha: "abc123" },
      capabilities: {
        streamingInput: true,
        partialMessages: true,
        permissionCallback: true,
        sessions: true,
        budget: true,
      },
    }),
  );
  sink.onEvent(
    rec({
      kind: "ca_turn_started",
      sessionId: SESSION_ID,
      turnIndex: 0,
      message: { role: "user", content: "Write a haiku to haiku.txt" },
    }),
  );
  sink.onEvent(
    rec({
      kind: "sdk_message",
      sessionId: SESSION_ID,
      payload: { type: "system", subtype: "init", model: "claude-haiku-4-5-20251001" },
    }),
  );

  // Assistant calls Write tool (stop_reason = "tool_use")
  sink.onEvent(
    rec({
      kind: "sdk_message",
      sessionId: SESSION_ID,
      payload: {
        type: "assistant",
        message: {
          model: "claude-haiku-4-5-20251001",
          stop_reason: "tool_use",
          content: [
            { type: "text", text: "I'll write the haiku now." },
            { type: "tool_use", id: "call-1", name: "Write", input: { path: "haiku.txt", content: "..." } },
          ],
        },
      },
    }),
  );

  // tool_result
  sink.onEvent(
    rec({
      kind: "sdk_message",
      sessionId: SESSION_ID,
      payload: {
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: "call-1", content: "file written", is_error: false }],
        },
      },
    }),
  );

  // Final assistant text (stop_reason = "end_turn")
  sink.onEvent(
    rec({
      kind: "sdk_message",
      sessionId: SESSION_ID,
      payload: {
        type: "assistant",
        message: {
          model: "claude-haiku-4-5-20251001",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "Done." }],
        },
      },
    }),
  );

  // turn_result + session_ended
  sink.onEvent(
    rec({
      kind: "sdk_message",
      sessionId: SESSION_ID,
      payload: {
        type: "result",
        subtype: "success",
        model: "claude-haiku-4-5-20251001",
        stop_reason: "end_turn",
      },
    }),
  );
  sink.onEvent(rec({ kind: "ca_session_ended", sessionId: SESSION_ID, reason: "complete" }));
}

function spanByName(spans: ReadableSpan[], name: string): ReadableSpan | undefined {
  return spans.find((s) => s.name === name);
}

// ---------------------------------------------------------------------------
// Pure mapper tests — no provider plumbing needed
// ---------------------------------------------------------------------------

describe("Anthropic block → SpecPart normaliser", () => {
  it("renames tool_use → tool_call with arguments field", () => {
    const part = blockToPart({ type: "tool_use", id: "x", name: "Write", input: { a: 1 } });
    expect(part).toEqual({ type: "tool_call", id: "x", name: "Write", arguments: { a: 1 } });
  });

  it("renames tool_result → tool_call_response with `response` field (NOT `result`)", () => {
    const part = blockToPart({ type: "tool_result", tool_use_id: "x", content: "ok" });
    expect(part).toEqual({ type: "tool_call_response", id: "x", response: "ok" });
    expect(part).not.toHaveProperty("result");
  });

  it("renames thinking → reasoning (spec uses `reasoning`, NOT `thinking`)", () => {
    const part = blockToPart({ type: "thinking", thinking: "let me think..." });
    expect(part).toEqual({ type: "reasoning", content: "let me think..." });
    expect(part?.type).not.toBe("thinking");
  });

  it("returns undefined for unknown block types instead of throwing", () => {
    expect(blockToPart({ type: "future_type_xyz" })).toBeUndefined();
    expect(blockToPart({})).toBeUndefined();
  });
});

describe("Anthropic stop_reason → spec finish_reason", () => {
  it("maps every documented Anthropic stop_reason to the spec enum", () => {
    expect(mapStopReasonToFinishReason("end_turn")).toBe("stop");
    expect(mapStopReasonToFinishReason("stop_sequence")).toBe("stop");
    expect(mapStopReasonToFinishReason("pause_turn")).toBe("stop");
    expect(mapStopReasonToFinishReason("max_tokens")).toBe("length");
    expect(mapStopReasonToFinishReason("tool_use")).toBe("tool_call");
    expect(mapStopReasonToFinishReason("refusal")).toBe("content_filter");
  });

  it("defaults unknown / undefined to 'stop' (spec requires the field)", () => {
    expect(mapStopReasonToFinishReason(undefined)).toBe("stop");
    expect(mapStopReasonToFinishReason("future_value")).toBe("stop");
  });

  it("infers tool_call when stop_reason is missing but parts contain a tool_call", () => {
    // Anthropic frequently omits stop_reason on streaming partials; without
    // this inference the message would mislabel itself "stop" even though
    // the model is clearly calling a tool.
    const partsWithToolCall: ReadonlyArray<{ type: string }> = [
      { type: "text" },
      { type: "tool_call" },
    ];
    expect(
      mapStopReasonToFinishReason(undefined, partsWithToolCall as never),
    ).toBe("tool_call");
  });

  it("returns 'stop' for reasoning- or text-only messages with no stop_reason", () => {
    const reasoningOnly: ReadonlyArray<{ type: string }> = [{ type: "reasoning" }];
    expect(mapStopReasonToFinishReason(undefined, reasoningOnly as never)).toBe("stop");

    const textOnly: ReadonlyArray<{ type: string }> = [{ type: "text" }];
    expect(mapStopReasonToFinishReason(undefined, textOnly as never)).toBe("stop");
  });
});

describe("redaction", () => {
  it("redacts API keys, JWT, email, AWS keys, GitHub tokens", () => {
    const text =
      "Email me at user@example.com with token gho_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa or " +
      "the key sk-ant-aaaaaaaaaaaaaaaaaaaaaaa. JWT: eyJhbGc.eyJzdWIiLCJqdGki.signature. AWS: AKIAIOSFODNN7EXAMPLE.";
    const out = applyRedaction(text, "[REDACTED:{kind}]");
    expect(out).toContain("[REDACTED:EMAIL]");
    expect(out).toContain("[REDACTED:GITHUB_TOKEN]");
    expect(out).toContain("[REDACTED:API_KEY]");
    expect(out).toContain("[REDACTED:JWT]");
    expect(out).toContain("[REDACTED:AWS_ACCESS_KEY]");
  });

  it("returns input unchanged when no patterns match", () => {
    expect(applyRedaction("just some text", "[REDACTED:{kind}]")).toBe("just some text");
  });
});

// ---------------------------------------------------------------------------
// Integration tests — configure() + OtelAuditSink + driven event sequence
// ---------------------------------------------------------------------------

describe("captureContent: false (default)", () => {
  it("emits NO gen_ai content attributes and NO inference log events", async () => {
    configure({ exporter: "none" });
    const sink = new OtelAuditSink();
    driveHappyTurn(sink);
    await loggerProvider.forceFlush();

    const spans = spanExporter.getFinishedSpans();
    for (const s of spans) {
      expect(s.attributes["gen_ai.input.messages"]).toBeUndefined();
      expect(s.attributes["gen_ai.output.messages"]).toBeUndefined();
      expect(s.attributes["gen_ai.system_instructions"]).toBeUndefined();
      expect(s.attributes["gen_ai.tool.call.arguments"]).toBeUndefined();
      expect(s.attributes["gen_ai.tool.call.result"]).toBeUndefined();
    }
    expect(logExporter.getFinishedLogRecords()).toEqual([]);
  });
});

describe("captureContent: true, mode: 'attributes'", () => {
  it("writes spec-shaped gen_ai.input.messages + gen_ai.output.messages on the chat span", async () => {
    configure({ exporter: "none", captureContent: true, captureContentMode: "attributes" });
    const sink = new OtelAuditSink();
    driveHappyTurn(sink);
    await loggerProvider.forceFlush();

    const spans = spanExporter.getFinishedSpans();
    const chat = spanByName(spans, "chat claude-haiku-4-5-20251001")!;
    expect(chat).toBeDefined();

    const inputJson = chat.attributes["gen_ai.input.messages"] as string;
    expect(typeof inputJson).toBe("string");
    const input: SpecInputMessage[] = JSON.parse(inputJson);
    expect(input).toHaveLength(1);
    expect(input[0]!.role).toBe("user");
    expect(input[0]!.parts).toEqual([{ type: "text", content: "Write a haiku to haiku.txt" }]);

    const outputJson = chat.attributes["gen_ai.output.messages"] as string;
    expect(typeof outputJson).toBe("string");
    const output: SpecOutputMessage[] = JSON.parse(outputJson);
    expect(output).toHaveLength(2);
    // First assistant message: text + tool_call, stop_reason=tool_use → tool_call
    expect(output[0]!.role).toBe("assistant");
    expect(output[0]!.finish_reason).toBe("tool_call");
    expect(output[0]!.parts).toEqual([
      { type: "text", content: "I'll write the haiku now." },
      {
        type: "tool_call",
        id: "call-1",
        name: "Write",
        arguments: { path: "haiku.txt", content: "..." },
      },
    ]);
    // Final assistant message: text, stop_reason=end_turn → stop
    expect(output[1]!.role).toBe("assistant");
    expect(output[1]!.finish_reason).toBe("stop");
    expect(output[1]!.parts).toEqual([{ type: "text", content: "Done." }]);

    // No log events in attributes-only mode.
    expect(logExporter.getFinishedLogRecords()).toEqual([]);
  });

  it("stamps gen_ai.tool.call.arguments and gen_ai.tool.call.result on the execute_tool span", () => {
    configure({ exporter: "none", captureContent: true, captureContentMode: "attributes" });
    const sink = new OtelAuditSink();
    driveHappyTurn(sink);

    const tool = spanByName(spanExporter.getFinishedSpans(), "execute_tool Write")!;
    expect(tool).toBeDefined();
    const args = JSON.parse(tool.attributes["gen_ai.tool.call.arguments"] as string);
    expect(args).toEqual({ path: "haiku.txt", content: "..." });
    const result = JSON.parse(tool.attributes["gen_ai.tool.call.result"] as string);
    expect(result).toBe("file written");
  });
});

describe("captureContent: true, mode: 'events'", () => {
  it("emits a gen_ai.client.inference.operation.details log event, NOT span attrs", async () => {
    configure({ exporter: "none", captureContent: true, captureContentMode: "events" });
    const sink = new OtelAuditSink();
    driveHappyTurn(sink);
    await loggerProvider.forceFlush();

    const chat = spanByName(spanExporter.getFinishedSpans(), "chat claude-haiku-4-5-20251001")!;
    expect(chat.attributes["gen_ai.input.messages"]).toBeUndefined();
    expect(chat.attributes["gen_ai.output.messages"]).toBeUndefined();

    const records = logExporter.getFinishedLogRecords();
    expect(records.length).toBeGreaterThanOrEqual(1);
    const detailsRecord = records.find((r: ReadableLogRecord) =>
      String(r.attributes?.["event.name"] ?? "").includes(
        "gen_ai.client.inference.operation.details",
      ),
    );
    expect(detailsRecord).toBeDefined();
    const body = detailsRecord!.body as Record<string, unknown>;
    expect(body["gen_ai.input.messages"]).toBeDefined();
    expect(body["gen_ai.output.messages"]).toBeDefined();
  });
});

describe("captureContent: true, mode: 'both'", () => {
  it("writes attributes AND emits a log event", async () => {
    configure({ exporter: "none", captureContent: true, captureContentMode: "both" });
    const sink = new OtelAuditSink();
    driveHappyTurn(sink);
    await loggerProvider.forceFlush();

    const chat = spanByName(spanExporter.getFinishedSpans(), "chat claude-haiku-4-5-20251001")!;
    expect(chat.attributes["gen_ai.input.messages"]).toBeDefined();
    expect(chat.attributes["gen_ai.output.messages"]).toBeDefined();
    expect(logExporter.getFinishedLogRecords().length).toBeGreaterThanOrEqual(1);
  });
});

describe("truncation", () => {
  it("clips serialized content to maxAttributeLength with a truncation marker", () => {
    configure({
      exporter: "none",
      captureContent: true,
      captureContentMode: "attributes",
      maxAttributeLength: 128,
    });
    const sink = new OtelAuditSink();
    // Drive a turn whose assistant text is much longer than 128 chars.
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
    sink.onEvent(rec({ kind: "ca_turn_started", sessionId: SESSION_ID, turnIndex: 0 }));
    sink.onEvent(
      rec({
        kind: "sdk_message",
        sessionId: SESSION_ID,
        payload: { type: "system", subtype: "init", model: "claude-haiku-4-5-20251001" },
      }),
    );
    const longText = "x".repeat(2000);
    sink.onEvent(
      rec({
        kind: "sdk_message",
        sessionId: SESSION_ID,
        payload: {
          type: "assistant",
          message: { stop_reason: "end_turn", content: [{ type: "text", text: longText }] },
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

    const chat = spanByName(spanExporter.getFinishedSpans(), "chat claude-haiku-4-5-20251001")!;
    const out = chat.attributes["gen_ai.output.messages"] as string;
    expect(out.length).toBeLessThanOrEqual(128);
    expect(out).toContain("[truncated:");
  });
});

describe("regression — live-run bugs", () => {
  it("gen_ai.input.messages is present and carries the user prompt", () => {
    // Live bug: claude-agent-sdk doesn't echo the initial user prompt as an
    // sdk_message, so we MUST get input.messages from ca_turn_started.message.
    configure({ exporter: "none", captureContent: true, captureContentMode: "attributes" });
    const sink = new OtelAuditSink();
    driveHappyTurn(sink);

    const chat = spanByName(spanExporter.getFinishedSpans(), "chat claude-haiku-4-5-20251001")!;
    const input: SpecInputMessage[] = JSON.parse(
      chat.attributes["gen_ai.input.messages"] as string,
    );
    expect(input).toHaveLength(1);
    expect(input[0]!.role).toBe("user");
    expect(input[0]!.parts).toEqual([
      { type: "text", content: "Write a haiku to haiku.txt" },
    ]);
  });

  it("an assistant message containing a tool_call uses finish_reason='tool_call', not 'stop'", () => {
    configure({ exporter: "none", captureContent: true, captureContentMode: "attributes" });
    const sink = new OtelAuditSink();
    // Simulate Anthropic's behaviour: the assistant message with the tool_use
    // block omits stop_reason because it's a streaming partial. Inference must
    // pick tool_call from the parts.
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
    sink.onEvent(
      rec({
        kind: "ca_turn_started",
        sessionId: SESSION_ID,
        turnIndex: 0,
        message: { role: "user", content: "go" },
      }),
    );
    sink.onEvent(
      rec({
        kind: "sdk_message",
        sessionId: SESSION_ID,
        payload: { type: "system", subtype: "init", model: "claude-haiku-4-5-20251001" },
      }),
    );
    // NO stop_reason on the assistant message with the tool call (the
    // partial-streaming case that broke the live output).
    sink.onEvent(
      rec({
        kind: "sdk_message",
        sessionId: SESSION_ID,
        payload: {
          type: "assistant",
          message: {
            content: [
              { type: "text", text: "I'll write the file." },
              { type: "tool_use", id: "call-x", name: "Write", input: { path: "x" } },
            ],
          },
        },
      }),
    );
    sink.onEvent(
      rec({
        kind: "sdk_message",
        sessionId: SESSION_ID,
        payload: {
          type: "user",
          message: { content: [{ type: "tool_result", tool_use_id: "call-x", content: "ok" }] },
        },
      }),
    );
    sink.onEvent(
      rec({
        kind: "sdk_message",
        sessionId: SESSION_ID,
        payload: {
          type: "assistant",
          message: { stop_reason: "end_turn", content: [{ type: "text", text: "done" }] },
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

    const chat = spanByName(spanExporter.getFinishedSpans(), "chat claude-haiku-4-5-20251001")!;
    const output: SpecOutputMessage[] = JSON.parse(
      chat.attributes["gen_ai.output.messages"] as string,
    );
    // First message had a tool_call AND no stop_reason → must infer tool_call.
    expect(output[0]!.finish_reason).toBe("tool_call");
    // Last message had stop_reason=end_turn → maps to stop.
    expect(output[output.length - 1]!.finish_reason).toBe("stop");
  });
});

describe("redaction wiring", () => {
  it("redacts PII inside captured content when redaction.enabled is true", () => {
    configure({
      exporter: "none",
      captureContent: true,
      captureContentMode: "attributes",
      redaction: { enabled: true, replacement: "[REDACTED:{kind}]" },
    });
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
    sink.onEvent(
      rec({
        kind: "ca_turn_started",
        sessionId: SESSION_ID,
        turnIndex: 0,
        message: {
          role: "user",
          content:
            "Reach me at attacker@example.com — my token is sk-ant-secrettoken12345678901",
        },
      }),
    );
    sink.onEvent(
      rec({
        kind: "sdk_message",
        sessionId: SESSION_ID,
        payload: { type: "system", subtype: "init", model: "claude-haiku-4-5-20251001" },
      }),
    );
    sink.onEvent(
      rec({
        kind: "sdk_message",
        sessionId: SESSION_ID,
        payload: {
          type: "assistant",
          message: { stop_reason: "end_turn", content: [{ type: "text", text: "done" }] },
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

    const chat = spanByName(spanExporter.getFinishedSpans(), "chat claude-haiku-4-5-20251001")!;
    const inputJson = chat.attributes["gen_ai.input.messages"] as string;
    expect(inputJson).not.toContain("attacker@example.com");
    expect(inputJson).not.toContain("sk-ant-secrettoken12345678901");
    expect(inputJson).toContain("[REDACTED:EMAIL]");
    expect(inputJson).toContain("[REDACTED:API_KEY]");
  });
});
