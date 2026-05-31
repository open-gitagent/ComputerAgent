import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { metrics, trace, context } from "@opentelemetry/api";
import {
  NodeTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-node";
import {
  MeterProvider,
  PeriodicExportingMetricReader,
  InMemoryMetricExporter,
  AggregationTemporality,
} from "@opentelemetry/sdk-metrics";
import type { AuditRecord } from "@computeragent/harness-server";
import type { HarnessEvent } from "@open-gitagent/protocol";
import { OtelAuditSink } from "./otel-audit-sink.js";
import {
  COMPUTERAGENT_ENGINE_NAME,
  COMPUTERAGENT_USAGE_COST_USD,
  GEN_AI_AGENT_ID,
  GEN_AI_AGENT_NAME,
  GEN_AI_AGENT_VERSION,
  GEN_AI_CONVERSATION_ID,
  GEN_AI_OPERATION_NAME,
  GEN_AI_PROVIDER_NAME,
  GEN_AI_REQUEST_MODEL,
  GEN_AI_RESPONSE_MODEL,
  GEN_AI_RESPONSE_FINISH_REASONS,
  GEN_AI_TOOL_CALL_ID,
  GEN_AI_TOOL_NAME,
  GEN_AI_USAGE_INPUT_TOKENS,
  GEN_AI_USAGE_OUTPUT_TOKENS,
  GenAiOperationName,
  GenAiProviderName,
} from "../semantic/attributes.js";

/**
 * Phase 2 end-to-end: drive OtelAuditSink with a synthetic event sequence
 * that mimics what `examples/hello.ts` would produce, using REAL OTel
 * providers wired to in-memory exporters. Asserts the resulting span tree
 * is shaped exactly the way the spec demands.
 *
 * We don't mock the TracerProvider — mocks would happily accept attribute
 * typos that real backends would silently drop.
 */

let spanExporter: InMemorySpanExporter;
let metricExporter: InMemoryMetricExporter;
let tracerProvider: NodeTracerProvider;
let meterProvider: MeterProvider;

beforeEach(() => {
  spanExporter = new InMemorySpanExporter();
  tracerProvider = new NodeTracerProvider();
  tracerProvider.addSpanProcessor(new SimpleSpanProcessor(spanExporter));
  tracerProvider.register();

  metricExporter = new InMemoryMetricExporter(AggregationTemporality.DELTA);
  meterProvider = new MeterProvider();
  meterProvider.addMetricReader(
    new PeriodicExportingMetricReader({ exporter: metricExporter, exportIntervalMillis: 60_000 }),
  );
  metrics.setGlobalMeterProvider(meterProvider);
});

afterEach(async () => {
  await tracerProvider.shutdown();
  await meterProvider.shutdown();
  // Detach globals so the next test starts clean.
  trace.disable();
  metrics.disable();
  context.disable();
});

const SESSION_ID = "sess-test-1";

function rec(event: HarnessEvent, eventId = 0): AuditRecord {
  return { sessionId: SESSION_ID, eventId, event, timestamp: Date.now() };
}

function feedHappyPath(sink: OtelAuditSink): void {
  // 1. session started — opens invoke_agent
  sink.onEvent(
    rec({
      kind: "ca_session_started",
      sessionId: SESSION_ID,
      engine: "claude-agent-sdk",
      identity: { name: "haiku-bot", version: "0.1.0", sha: "deadbeef" },
      capabilities: {
        streamingInput: true,
        partialMessages: true,
        permissionCallback: true,
        sessions: true,
        budget: true,
      },
    }),
  );

  // 2. system_init sdk_message — locks in the model
  sink.onEvent(
    rec({
      kind: "sdk_message",
      sessionId: SESSION_ID,
      payload: { type: "system", subtype: "init", model: "claude-haiku-4-5-20251001", session_id: "anth-1" },
    }),
  );

  // 3. assistant text — opens chat span
  sink.onEvent(
    rec({
      kind: "sdk_message",
      sessionId: SESSION_ID,
      payload: {
        type: "assistant",
        message: { model: "claude-haiku-4-5-20251001", content: [{ type: "text", text: "On it." }] },
      },
    }),
  );

  // 4. tool_use sdk_message — opens execute_tool span (no permission gate fired
  //    in this test, simulating bypassPermissions mode which hello.ts uses)
  sink.onEvent(
    rec({
      kind: "sdk_message",
      sessionId: SESSION_ID,
      payload: {
        type: "assistant",
        message: {
          model: "claude-haiku-4-5-20251001",
          content: [{ type: "tool_use", id: "call-1", name: "Write", input: { path: "haiku.txt", content: "..." } }],
        },
      },
    }),
  );

  // 5. tool_result — closes execute_tool span
  sink.onEvent(
    rec({
      kind: "sdk_message",
      sessionId: SESSION_ID,
      payload: {
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "call-1", content: "ok", is_error: false }] },
      },
    }),
  );

  // 6. usage snapshot (cumulative, end-of-turn)
  sink.onEvent(
    rec({
      kind: "ca_usage_snapshot",
      sessionId: SESSION_ID,
      inputTokens: 142,
      outputTokens: 38,
      costUsd: 0.0017,
      costSemantic: "cumulative",
    }),
  );

  // 7. result sdk_message — closes chat span
  sink.onEvent(
    rec({
      kind: "sdk_message",
      sessionId: SESSION_ID,
      payload: {
        type: "result",
        subtype: "success",
        model: "claude-haiku-4-5-20251001",
        stop_reason: "end_turn",
        is_error: false,
      },
    }),
  );

  // 8. session ended — closes invoke_agent, flushes usage
  sink.onEvent(rec({ kind: "ca_session_ended", sessionId: SESSION_ID, reason: "complete" }));
}

function spanByName(spans: ReadableSpan[], name: string): ReadableSpan | undefined {
  return spans.find((s) => s.name === name);
}

describe("OtelAuditSink — phase 2 happy path", () => {
  it("emits invoke_agent → chat → execute_tool tree with spec-compliant attributes", async () => {
    const sink = new OtelAuditSink();
    feedHappyPath(sink);

    const spans = spanExporter.getFinishedSpans();

    // Three spans total.
    expect(spans.map((s) => s.name).sort()).toEqual([
      "chat claude-haiku-4-5-20251001",
      "execute_tool Write",
      "invoke_agent haiku-bot",
    ]);

    // invoke_agent — root, required attrs
    const agent = spanByName(spans, "invoke_agent haiku-bot")!;
    expect(agent).toBeDefined();
    expect(agent.attributes[GEN_AI_OPERATION_NAME]).toBe(GenAiOperationName.INVOKE_AGENT);
    expect(agent.attributes[GEN_AI_PROVIDER_NAME]).toBe(GenAiProviderName.ANTHROPIC);
    expect(agent.attributes[GEN_AI_AGENT_NAME]).toBe("haiku-bot");
    expect(agent.attributes[GEN_AI_AGENT_VERSION]).toBe("0.1.0");
    expect(agent.attributes[GEN_AI_AGENT_ID]).toBe("deadbeef");
    expect(agent.attributes[GEN_AI_CONVERSATION_ID]).toBe(SESSION_ID);
    expect(agent.attributes[COMPUTERAGENT_ENGINE_NAME]).toBe("claude-agent-sdk");
    expect(agent.attributes[GEN_AI_REQUEST_MODEL]).toBe("claude-haiku-4-5-20251001");
    // Usage rolled up onto the agent span on session end.
    expect(agent.attributes[GEN_AI_USAGE_INPUT_TOKENS]).toBe(142);
    expect(agent.attributes[GEN_AI_USAGE_OUTPUT_TOKENS]).toBe(38);
    expect(agent.attributes[COMPUTERAGENT_USAGE_COST_USD]).toBe(0.0017);

    // chat — child of invoke_agent, required attrs
    const chat = spanByName(spans, "chat claude-haiku-4-5-20251001")!;
    expect(chat).toBeDefined();
    expect(chat.attributes[GEN_AI_OPERATION_NAME]).toBe(GenAiOperationName.CHAT);
    expect(chat.attributes[GEN_AI_PROVIDER_NAME]).toBe(GenAiProviderName.ANTHROPIC);
    expect(chat.attributes[GEN_AI_REQUEST_MODEL]).toBe("claude-haiku-4-5-20251001");
    expect(chat.attributes[GEN_AI_RESPONSE_MODEL]).toBe("claude-haiku-4-5-20251001");
    expect(chat.attributes[GEN_AI_RESPONSE_FINISH_REASONS]).toEqual(["end_turn"]);
    expect(chat.attributes[GEN_AI_CONVERSATION_ID]).toBe(SESSION_ID);
    expect(chat.parentSpanId).toBe(agent.spanContext().spanId);

    // execute_tool — child of chat, required attrs
    const tool = spanByName(spans, "execute_tool Write")!;
    expect(tool).toBeDefined();
    expect(tool.attributes[GEN_AI_OPERATION_NAME]).toBe(GenAiOperationName.EXECUTE_TOOL);
    expect(tool.attributes[GEN_AI_TOOL_NAME]).toBe("Write");
    expect(tool.attributes[GEN_AI_TOOL_CALL_ID]).toBe("call-1");
    expect(tool.attributes[GEN_AI_CONVERSATION_ID]).toBe(SESSION_ID);
    expect(tool.parentSpanId).toBe(chat.spanContext().spanId);

    // All three spans share the SAME trace id (invoke_agent is the root).
    const traceId = agent.spanContext().traceId;
    expect(chat.spanContext().traceId).toBe(traceId);
    expect(tool.spanContext().traceId).toBe(traceId);
  });

  it("does not emit any gen_ai.input.messages by default (content capture off)", () => {
    const sink = new OtelAuditSink();
    feedHappyPath(sink);
    const spans = spanExporter.getFinishedSpans();
    for (const s of spans) {
      expect(s.attributes["gen_ai.input.messages"]).toBeUndefined();
      expect(s.attributes["gen_ai.output.messages"]).toBeUndefined();
      expect(s.attributes["gen_ai.system_instructions"]).toBeUndefined();
    }
  });

  it("records gen_ai.client.token.usage histograms split by token type", async () => {
    const sink = new OtelAuditSink();
    feedHappyPath(sink);

    // Force a metric collection.
    await meterProvider.forceFlush();
    const collected = metricExporter.getMetrics();
    expect(collected.length).toBeGreaterThan(0);

    // Find token.usage points.
    let inputSeen = false;
    let outputSeen = false;
    for (const resourceMetric of collected) {
      for (const scopeMetric of resourceMetric.scopeMetrics) {
        for (const metric of scopeMetric.metrics) {
          if (metric.descriptor.name !== "gen_ai.client.token.usage") continue;
          for (const dp of metric.dataPoints) {
            const tokenType = dp.attributes["gen_ai.token.type"];
            if (tokenType === "input") inputSeen = true;
            if (tokenType === "output") outputSeen = true;
          }
        }
      }
    }
    expect(inputSeen).toBe(true);
    expect(outputSeen).toBe(true);
  });
});

describe("OtelAuditSink — error path", () => {
  it("closes all open spans with error.type=<reason> when session ends with error", () => {
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
          message: { content: [{ type: "text", text: "thinking..." }] },
        },
      }),
    );
    // Session aborts before the chat could finish — half-open spans should
    // close cleanly with error status.
    sink.onEvent(
      rec({ kind: "ca_session_ended", sessionId: SESSION_ID, reason: "cancelled" }),
    );

    const spans = spanExporter.getFinishedSpans();
    const names = spans.map((s) => s.name).sort();
    expect(names).toEqual(["chat claude-haiku-4-5-20251001", "invoke_agent haiku-bot"]);

    for (const s of spans) {
      // SpanStatusCode.ERROR === 2 per the OTel API enum.
      expect(s.status.code).toBe(2);
      expect(s.attributes["error.type"]).toBe("cancelled");
    }
  });
});
