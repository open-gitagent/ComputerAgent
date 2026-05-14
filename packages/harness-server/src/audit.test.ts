import { describe, expect, it } from "vitest";
import { MockEngine, MockLoader, collectSseEvents } from "@computeragent/testing";
import { createHarnessServer } from "./app.js";
import { MemoryAuditSink, type AuditSink, type AuditRecord } from "./audit.js";

function makeApp(sink: AuditSink) {
  const engine = new MockEngine([
    { kind: "emit", payload: { type: "system" } },
    { kind: "emit", payload: { type: "assistant", text: "hi" } },
  ]);
  return createHarnessServer({
    engines: { mock: engine },
    identityLoaders: { mock: new MockLoader({ metadata: { name: "test", version: "0.0.1" } }) },
    auditSink: sink,
  });
}

const baseBody = {
  engine: "mock",
  identity: { loader: "mock", source: { type: "local", path: "/tmp" } },
};

describe("AuditSink", () => {
  it("receives every event with monotonic ids and matching sessionId", async () => {
    const sink = new MemoryAuditSink();
    const app = makeApp(sink);

    const create = await app.request("/v1/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(baseBody),
    });
    const { sessionId } = (await create.json()) as { sessionId: string };

    const res = await app.request(`/v1/sessions/${sessionId}/events`);
    const events = await collectSseEvents(res.body!);

    expect(sink.records.length).toBe(events.length);
    sink.records.forEach((r, i) => {
      expect(r.eventId).toBe(i);
      expect(r.sessionId).toBe(sessionId);
      expect(r.event.kind).toBe(events[i]?.kind);
      expect(typeof r.timestamp).toBe("number");
    });
  });

  it("a throwing sink does not break the session", async () => {
    const sink: AuditSink = {
      onEvent() {
        throw new Error("sink boom");
      },
    };
    const app = makeApp(sink);
    const create = await app.request("/v1/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(baseBody),
    });
    const { sessionId } = (await create.json()) as { sessionId: string };
    const res = await app.request(`/v1/sessions/${sessionId}/events`);
    const events = await collectSseEvents(res.body!);
    expect(events[0]?.kind).toBe("ca_session_started");
    expect(events[events.length - 1]?.kind).toBe("ca_session_ended");
  });

  it("an async-rejecting sink does not break the session", async () => {
    const records: AuditRecord[] = [];
    const sink: AuditSink = {
      async onEvent(r) {
        records.push(r);
        throw new Error("async fail");
      },
    };
    const app = makeApp(sink);
    const create = await app.request("/v1/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(baseBody),
    });
    const { sessionId } = (await create.json()) as { sessionId: string };
    const res = await app.request(`/v1/sessions/${sessionId}/events`);
    const events = await collectSseEvents(res.body!);
    expect(events.length).toBeGreaterThan(0);
    expect(records.length).toBe(events.length);
  });
});
