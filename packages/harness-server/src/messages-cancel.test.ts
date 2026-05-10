import { describe, expect, it } from "vitest";
import { MockEngine, MockLoader, parseSseChunk } from "@computeragent/testing";
import { createHarnessServer } from "./app.js";

const baseBody = {
  engine: "mock",
  identity: { loader: "mock", source: { type: "local", path: "/tmp" } },
};

function makeApp(engine: MockEngine) {
  return createHarnessServer({
    engines: { mock: engine },
    identityLoaders: { mock: new MockLoader() },
  });
}

async function readSseEvents(res: Response, max = 50) {
  const out: { kind: string; data: unknown }[] = [];
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (out.length < max) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const { events, remainder } = parseSseChunk(buf);
    buf = remainder;
    for (const e of events) {
      out.push({ kind: e.kind, data: e.data });
      const data = e.data as { kind?: string };
      if (data?.kind === "ca_session_ended") return out;
    }
  }
  return out;
}

describe("POST /v1/sessions/:id/messages", () => {
  it("pushes a user message into the engine queue", async () => {
    const engine = new MockEngine([
      { kind: "wait_for_user_message" },
      { kind: "emit", payload: { type: "assistant", text: "got it" } },
    ]);
    const app = makeApp(engine);

    const created = await app.request("/v1/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...baseBody, streamingInput: true }),
    });
    const { sessionId } = (await created.json()) as { sessionId: string };

    // Open events stream first so the engine starts running and blocks on user input
    const eventsP = app.request(`/v1/sessions/${sessionId}/events`);

    // POST a message that should unblock the engine
    const sent = await app.request(`/v1/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: { role: "user", content: "hi engine" } }),
    });
    expect(sent.status).toBe(200);
    expect(await sent.json()).toEqual({ ok: true });

    // Streaming-input: client must close the queue when done sending.
    await app.request(`/v1/sessions/${sessionId}/end-input`, { method: "POST" });

    const events = await readSseEvents(await eventsP);
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain("ca_session_started");
    expect(kinds).toContain("sdk_message");
    expect(kinds[kinds.length - 1]).toBe("ca_session_ended");

    expect(engine.received.userMessages).toHaveLength(1);
    expect(engine.received.userMessages[0]).toMatchObject({ role: "user", content: "hi engine" });
  });

  it("404s on unknown session", async () => {
    const app = makeApp(new MockEngine([]));
    const res = await app.request("/v1/sessions/sess_nope/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: { role: "user", content: "x" } }),
    });
    expect(res.status).toBe(404);
  });

  it("rejects malformed body", async () => {
    const engine = new MockEngine([{ kind: "emit", payload: {} }]);
    const app = makeApp(engine);
    const created = await app.request("/v1/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(baseBody),
    });
    const { sessionId } = (await created.json()) as { sessionId: string };

    const res = await app.request(`/v1/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: { role: "system", content: "no" } }),
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /v1/sessions/:id/cancel", () => {
  it("aborts a running session and the SSE stream ends with reason 'cancelled'", async () => {
    const engine = new MockEngine([
      { kind: "emit", payload: { type: "system" } },
      { kind: "wait_ms", ms: 5000 },
      { kind: "emit", payload: { type: "should_never_arrive" } },
    ]);
    const app = makeApp(engine);

    const created = await app.request("/v1/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(baseBody),
    });
    const { sessionId } = (await created.json()) as { sessionId: string };

    const eventsP = app.request(`/v1/sessions/${sessionId}/events`);

    // Give the engine a tick to start, then cancel.
    setTimeout(() => {
      void app.request(`/v1/sessions/${sessionId}/cancel`, { method: "POST" });
    }, 30);

    const events = await readSseEvents(await eventsP);
    const ended = events[events.length - 1];
    expect(ended?.kind).toBe("ca_session_ended");
    const data = ended?.data as { reason: string };
    expect(data.reason).toBe("cancelled");
  });

  it("404s on unknown session", async () => {
    const app = makeApp(new MockEngine([]));
    const res = await app.request("/v1/sessions/sess_nope/cancel", { method: "POST" });
    expect(res.status).toBe(404);
  });
});
