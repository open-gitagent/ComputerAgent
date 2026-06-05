// RBAC / multi-tenancy identity stamping. Verifies that when a producer attaches
// `identity` to the (widened) AuditRecord, the OtelAuditSink stamps
// `computeragent.{agent,group,owner,actor}.id` on EVERY span of the trace — and
// that omitting identity leaves those attributes off entirely.

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
import { OtelAuditSink, type InvocationIdentity } from "./otel-audit-sink.js";
import {
  COMPUTERAGENT_AGENT_ID,
  COMPUTERAGENT_GROUP_ID,
  COMPUTERAGENT_OWNER_ID,
  COMPUTERAGENT_ACTOR_ID,
} from "../semantic/attributes.js";

let spanExporter: InMemorySpanExporter;
let tracerProvider: NodeTracerProvider;
let meterProvider: MeterProvider;

beforeEach(() => {
  spanExporter = new InMemorySpanExporter();
  tracerProvider = new NodeTracerProvider();
  tracerProvider.addSpanProcessor(new SimpleSpanProcessor(spanExporter));
  tracerProvider.register();

  const metricExporter = new InMemoryMetricExporter(AggregationTemporality.DELTA);
  meterProvider = new MeterProvider();
  meterProvider.addMetricReader(
    new PeriodicExportingMetricReader({ exporter: metricExporter, exportIntervalMillis: 60_000 }),
  );
  metrics.setGlobalMeterProvider(meterProvider);
});

afterEach(async () => {
  await tracerProvider.shutdown();
  await meterProvider.shutdown();
  trace.disable();
  metrics.disable();
  context.disable();
});

const SESSION_ID = "sess-identity-1";

function rec(event: HarnessEvent, identity?: InvocationIdentity): AuditRecord {
  const base: AuditRecord & { identity?: InvocationIdentity } = {
    sessionId: SESSION_ID,
    eventId: 0,
    event,
    timestamp: Date.now(),
  };
  if (identity) base.identity = identity;
  return base;
}

/** Minimal session that opens invoke_agent + chat spans. Identity (if any) is
 *  attached to ca_session_started — that's where the sink captures it. */
function feed(sink: OtelAuditSink, identity?: InvocationIdentity): void {
  sink.onEvent(
    rec(
      {
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
      },
      identity,
    ),
  );
  sink.onEvent(
    rec({
      kind: "sdk_message",
      sessionId: SESSION_ID,
      payload: { type: "system", subtype: "init", model: "claude-haiku-4-5-20251001", session_id: "anth-1" },
    }),
  );
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
  sink.onEvent(rec({ kind: "ca_session_ended", sessionId: SESSION_ID, reason: "complete" }));
}

describe("OtelAuditSink — RBAC identity attributes", () => {
  it("stamps computeragent.{agent,group,owner,actor}.id on every span", () => {
    const sink = new OtelAuditSink();
    feed(sink, {
      agentId: "665f00000000000000000abc",
      groupId: "team-alpha",
      ownerId: "user-123",
      actorId: "key_caller_9",
    });

    const spans = spanExporter.getFinishedSpans();
    expect(spans.length).toBeGreaterThanOrEqual(2); // invoke_agent + chat

    // Stamped on EVERY span — a flat WHERE on group/owner selects the whole trace.
    for (const s of spans) {
      expect(s.attributes[COMPUTERAGENT_AGENT_ID]).toBe("665f00000000000000000abc");
      expect(s.attributes[COMPUTERAGENT_GROUP_ID]).toBe("team-alpha");
      expect(s.attributes[COMPUTERAGENT_OWNER_ID]).toBe("user-123");
      expect(s.attributes[COMPUTERAGENT_ACTOR_ID]).toBe("key_caller_9");
    }
  });

  it("omits the attributes entirely when no identity is supplied", () => {
    const sink = new OtelAuditSink();
    feed(sink); // no identity

    const spans = spanExporter.getFinishedSpans();
    expect(spans.length).toBeGreaterThanOrEqual(2);
    for (const s of spans) {
      expect(s.attributes[COMPUTERAGENT_AGENT_ID]).toBeUndefined();
      expect(s.attributes[COMPUTERAGENT_GROUP_ID]).toBeUndefined();
      expect(s.attributes[COMPUTERAGENT_OWNER_ID]).toBeUndefined();
      expect(s.attributes[COMPUTERAGENT_ACTOR_ID]).toBeUndefined();
    }
  });

  it("stamps only the identity fields that are present", () => {
    const sink = new OtelAuditSink();
    // owner present, group null, actor null, agentId present — partial identity
    // (e.g. an agent with no owner group, run anonymously).
    feed(sink, { agentId: "abc123", ownerId: "user-7", groupId: null, actorId: null });

    const spans = spanExporter.getFinishedSpans();
    expect(spans.length).toBeGreaterThanOrEqual(2);
    for (const s of spans) {
      expect(s.attributes[COMPUTERAGENT_AGENT_ID]).toBe("abc123");
      expect(s.attributes[COMPUTERAGENT_OWNER_ID]).toBe("user-7");
      expect(s.attributes[COMPUTERAGENT_GROUP_ID]).toBeUndefined();
      expect(s.attributes[COMPUTERAGENT_ACTOR_ID]).toBeUndefined();
    }
  });
});
