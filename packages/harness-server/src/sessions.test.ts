import { describe, expect, it } from "vitest";
import { MockEngine, MockLoader, parseSseChunk } from "@computeragent/testing";
import { createHarnessServer } from "./app.js";

function makeApp(engine: MockEngine = new MockEngine([])) {
  return createHarnessServer({
    engines: { mock: engine },
    identityLoaders: { mock: new MockLoader({ metadata: { name: "test", version: "0.0.1" } }) },
  });
}

const baseBody = {
  engine: "mock",
  identity: { loader: "mock", source: { type: "local", path: "/tmp" } },
};

async function readSseEvents(res: Response, max = 50): Promise<{ kind: string; data: unknown }[]> {
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

describe("POST /v1/sessions", () => {
  it("creates a session and returns sessionId + capabilities", async () => {
    const app = makeApp();
    const res = await app.request("/v1/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(baseBody),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { sessionId?: string; engine?: string; identity?: { name: string }; eventsUrl?: string };
    expect(body.sessionId).toBeDefined();
    expect(body.engine).toBe("mock");
    expect(body.identity?.name).toBe("test");
    expect(body.eventsUrl).toBe(`/v1/sessions/${body.sessionId}/events`);
  });

  it("rejects unknown engine", async () => {
    const app = makeApp();
    const res = await app.request("/v1/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...baseBody, engine: "no-such" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe("UNKNOWN_ENGINE");
  });

  it("rejects unknown loader", async () => {
    const app = makeApp();
    const res = await app.request("/v1/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...baseBody, identity: { loader: "no-such", source: { type: "local", path: "/tmp" } } }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe("UNKNOWN_LOADER");
  });

  it("rejects malformed body", async () => {
    const app = makeApp();
    const res = await app.request("/v1/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ engine: "mock" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /v1/sessions/:id/events", () => {
  it("streams ca_session_started, sdk_message events, ca_session_ended", async () => {
    const engine = new MockEngine([
      { kind: "emit", payload: { type: "system" } },
      { kind: "emit", payload: { type: "assistant", text: "hi" } },
    ]);
    const app = makeApp(engine);

    const create = await app.request("/v1/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(baseBody),
    });
    const { sessionId } = await create.json() as { sessionId: string };

    const events = await readSseEvents(await app.request(`/v1/sessions/${sessionId}/events`));
    expect(events.map((e) => e.kind)).toEqual([
      "ca_session_started",
      "sdk_message",
      "sdk_message",
      "ca_session_ended",
    ]);
    const ended = events[events.length - 1]?.data as { reason: string };
    expect(ended.reason).toBe("complete");
  });

  it("404s on unknown session", async () => {
    const app = makeApp();
    const res = await app.request("/v1/sessions/sess_nope/events");
    expect(res.status).toBe(404);
  });
});

describe("POST /v1/chat", () => {
  it("runs an agent end-to-end, streaming events directly in the response body", async () => {
    const engine = new MockEngine([
      { kind: "emit", payload: { type: "assistant", text: "hello" } },
      { kind: "emit", payload: { type: "result", text: "done" } },
    ]);
    const app = makeApp(engine);

    const res = await app.request("/v1/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(baseBody),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/event-stream/);

    const events = await readSseEvents(res);
    const kinds = events.map((e) => e.kind);
    expect(kinds[0]).toBe("ca_session_started");
    expect(kinds).toContain("sdk_message");
    expect(kinds[kinds.length - 1]).toBe("ca_session_ended");
  });

  it("includes sessionId in the first event so clients can hit /permission later", async () => {
    const engine = new MockEngine([{ kind: "emit", payload: { type: "x" } }]);
    const app = makeApp(engine);
    const res = await app.request("/v1/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(baseBody),
    });
    const events = await readSseEvents(res);
    const started = events[0]?.data as { sessionId?: string };
    expect(started.sessionId).toBeDefined();
    expect(started.sessionId).toMatch(/^sess_/);
  });
});

describe("body.options merging", () => {
  it("body.options override loader options on conflict; loader options preserved on non-conflict", async () => {
    const loader = new MockLoader({ options: { model: "from-loader", maxTurns: 5 } });
    const engine = new MockEngine([{ kind: "emit", payload: {} }]);
    const app = createHarnessServer({
      engines: { mock: engine },
      identityLoaders: { mock: loader },
    });

    // Capture engine ctx via a wrapper
    let seenOptions: unknown;
    const wrappedEngine = {
      name: engine.name,
      capabilities: engine.capabilities,
      async *startSession(ctx: import("@computeragent/protocol").EngineContext<unknown>) {
        seenOptions = ctx.options;
        for await (const ev of engine.startSession(ctx)) yield ev;
      },
    };
    const app2 = createHarnessServer({
      engines: { mock: wrappedEngine },
      identityLoaders: { mock: loader },
    });

    const created = await app2.request("/v1/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...baseBody, options: { model: "from-body", permissionMode: "bypassPermissions" } }),
    });
    const { sessionId } = (await created.json()) as { sessionId: string };
    const eventsRes = await app2.request(`/v1/sessions/${sessionId}/events`);
    // Drain until the engine has started (we'll see at least one sdk_message).
    const reader = eventsRes.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      if (buf.includes("sdk_message") || buf.includes("ca_session_ended")) break;
    }
    await reader.cancel();
    expect(seenOptions).toEqual({
      model: "from-body",
      maxTurns: 5,
      permissionMode: "bypassPermissions",
    });
  });
});

describe("DELETE /v1/sessions/:id", () => {
  it("cancels a running session and removes it", async () => {
    const app = makeApp();
    const create = await app.request("/v1/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(baseBody),
    });
    const { sessionId } = await create.json() as { sessionId: string };

    const del = await app.request(`/v1/sessions/${sessionId}`, { method: "DELETE" });
    expect(del.status).toBe(200);

    const get = await app.request(`/v1/sessions/${sessionId}`);
    expect(get.status).toBe(404);
  });
});
