import { describe, expect, it } from "vitest";
import { MockEngine, MockLoader, parseSseChunk } from "@computeragent/testing";
import { createHarnessServer } from "./app.js";

function makeApp(engine: MockEngine) {
  return createHarnessServer({
    engines: { mock: engine },
    identityLoaders: { mock: new MockLoader({ metadata: { name: "test", version: "0.0.1" } }) },
  });
}

const baseBody = {
  engine: "mock",
  identity: { loader: "mock", source: { type: "local", path: "/tmp" } },
};

interface ParsedEvent { kind: string; id?: string; data: { kind?: string } & Record<string, unknown> }

async function drainSse(res: Response, opts: { until?: (e: ParsedEvent) => boolean; max?: number } = {}): Promise<ParsedEvent[]> {
  const max = opts.max ?? 100;
  const out: ParsedEvent[] = [];
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
      const ev = e as ParsedEvent;
      out.push(ev);
      if (opts.until && opts.until(ev)) {
        await reader.cancel().catch(() => {});
        return out;
      }
      if (!opts.until && ev.data?.kind === "ca_session_ended") return out;
    }
  }
  return out;
}

describe("Last-Event-ID resume", () => {
  it("first SSE consumer receives ids 0, 1, 2, ...", async () => {
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
    const { sessionId } = (await create.json()) as { sessionId: string };

    const events = await drainSse(await app.request(`/v1/sessions/${sessionId}/events`));
    const ids = events.map((e) => e.id);
    expect(ids).toEqual(["0", "1", "2", "3"]);
  });

  it("reconnect with Last-Event-ID skips already-seen events", async () => {
    const engine = new MockEngine([
      { kind: "emit", payload: { type: "system" } },
      { kind: "emit", payload: { type: "assistant", text: "a" } },
      { kind: "emit", payload: { type: "assistant", text: "b" } },
    ]);
    const app = makeApp(engine);
    const create = await app.request("/v1/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(baseBody),
    });
    const { sessionId } = (await create.json()) as { sessionId: string };

    // First consumer drains everything, so the buffer is populated and engine is done.
    const first = await drainSse(await app.request(`/v1/sessions/${sessionId}/events`));
    expect(first.length).toBeGreaterThanOrEqual(4);

    // Reconnect with Last-Event-ID: 1 — expect events with id 2, 3, ...
    const resumed = await drainSse(
      await app.request(`/v1/sessions/${sessionId}/events`, {
        headers: { "Last-Event-ID": "1" },
      }),
    );
    const ids = resumed.map((e) => e.id);
    expect(ids[0]).toBe("2");
    expect(ids).not.toContain("0");
    expect(ids).not.toContain("1");
  });

  it("reconnect with Last-Event-ID past end of buffer terminates immediately", async () => {
    const engine = new MockEngine([{ kind: "emit", payload: { type: "x" } }]);
    const app = makeApp(engine);
    const create = await app.request("/v1/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(baseBody),
    });
    const { sessionId } = (await create.json()) as { sessionId: string };

    // Drain the engine fully.
    await drainSse(await app.request(`/v1/sessions/${sessionId}/events`));

    // Last-Event-ID well past last emitted id → no events to deliver.
    const resumed = await drainSse(
      await app.request(`/v1/sessions/${sessionId}/events`, {
        headers: { "Last-Event-ID": "9999" },
      }),
    );
    expect(resumed).toEqual([]);
  });

  it("two concurrent consumers each see every event with identical ids", async () => {
    // Engine yields a couple of events with a small delay so both consumers can connect.
    const engine = new MockEngine([
      { kind: "wait_ms", ms: 20 },
      { kind: "emit", payload: { type: "system" } },
      { kind: "wait_ms", ms: 20 },
      { kind: "emit", payload: { type: "assistant", text: "hi" } },
    ]);
    const app = makeApp(engine);
    const create = await app.request("/v1/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(baseBody),
    });
    const { sessionId } = (await create.json()) as { sessionId: string };

    const [a, b] = await Promise.all([
      drainSse(await app.request(`/v1/sessions/${sessionId}/events`)),
      drainSse(await app.request(`/v1/sessions/${sessionId}/events`)),
    ]);
    expect(a.map((e) => e.id)).toEqual(b.map((e) => e.id));
    expect(a.map((e) => e.data.kind)).toEqual([
      "ca_session_started",
      "sdk_message",
      "sdk_message",
      "ca_session_ended",
    ]);
  });

  it("?lastEventId=N query param also works (for clients that can't set headers)", async () => {
    const engine = new MockEngine([
      { kind: "emit", payload: { type: "system" } },
      { kind: "emit", payload: { type: "assistant", text: "a" } },
    ]);
    const app = makeApp(engine);
    const create = await app.request("/v1/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(baseBody),
    });
    const { sessionId } = (await create.json()) as { sessionId: string };

    await drainSse(await app.request(`/v1/sessions/${sessionId}/events`));

    const resumed = await drainSse(
      await app.request(`/v1/sessions/${sessionId}/events?lastEventId=0`),
    );
    expect(resumed[0]?.id).toBe("1");
  });
});
