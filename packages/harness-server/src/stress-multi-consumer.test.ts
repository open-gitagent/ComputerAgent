/**
 * Stress test: many concurrent SSE consumers on a single session.
 *
 * Validates the replay-buffer fan-out under concurrent read pressure:
 *   - all consumers see every event
 *   - all consumers see identical, monotonic ids
 *   - reconnect with Last-Event-ID joins mid-stream cleanly
 *
 * Catches races where a slow consumer might miss events the buffer trims, or
 * where a fast consumer's iterator advances out of step with the producer.
 */
import { describe, expect, it } from "vitest";
import { MockEngine, MockLoader, parseSseChunk } from "@computeragent/testing";
import { createHarnessServer } from "./app.js";

interface ParsedEvent { kind: string; id?: string; data: { kind?: string } & Record<string, unknown> }

async function drain(res: Response, max = 200): Promise<ParsedEvent[]> {
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
      if (ev.data?.kind === "ca_session_ended") return out;
    }
  }
  return out;
}

const baseBody = {
  engine: "mock",
  identity: { loader: "mock", source: { type: "local", path: "/tmp" } },
};

describe("Stress: many concurrent SSE consumers per session", () => {
  it("5 concurrent consumers on a fresh session each see every event with identical ids", async () => {
    // Engine has small delays between emits so all 5 consumers have time to attach.
    const engine = new MockEngine([
      { kind: "wait_ms", ms: 30 },
      { kind: "emit", payload: { type: "system" } },
      { kind: "wait_ms", ms: 20 },
      { kind: "emit", payload: { type: "assistant", text: "a" } },
      { kind: "wait_ms", ms: 20 },
      { kind: "emit", payload: { type: "assistant", text: "b" } },
      { kind: "wait_ms", ms: 20 },
      { kind: "emit", payload: { type: "result", text: "done" } },
    ]);
    const app = createHarnessServer({
      engines: { mock: engine },
      identityLoaders: { mock: new MockLoader({ metadata: { name: "t", version: "0" } }) },
    });
    const create = await app.request("/v1/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(baseBody),
    });
    const { sessionId } = (await create.json()) as { sessionId: string };

    // Fire 5 concurrent /events requests.
    const consumers = await Promise.all(
      Array.from({ length: 5 }, () => app.request(`/v1/sessions/${sessionId}/events`)),
    );
    const drains = await Promise.all(consumers.map((r) => drain(r)));

    // Every consumer saw the same number of events.
    const counts = new Set(drains.map((d) => d.length));
    expect(counts.size).toBe(1);

    // Every consumer saw identical ids and identical kinds.
    const ref = drains[0]!;
    for (const got of drains.slice(1)) {
      expect(got.map((e) => e.id)).toEqual(ref.map((e) => e.id));
      expect(got.map((e) => e.data.kind)).toEqual(ref.map((e) => e.data.kind));
    }

    // Ids are 0, 1, 2, ... contiguous.
    expect(ref.map((e) => Number(e.id))).toEqual(ref.map((_, i) => i));
  });

  it("late joiner with Last-Event-ID skips already-delivered events even after the producer finished", async () => {
    const engine = new MockEngine([
      { kind: "emit", payload: { type: "system" } },
      { kind: "emit", payload: { type: "assistant", text: "a" } },
      { kind: "emit", payload: { type: "assistant", text: "b" } },
      { kind: "emit", payload: { type: "assistant", text: "c" } },
    ]);
    const app = createHarnessServer({
      engines: { mock: engine },
      identityLoaders: { mock: new MockLoader({ metadata: { name: "t", version: "0" } }) },
    });
    const create = await app.request("/v1/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(baseBody),
    });
    const { sessionId } = (await create.json()) as { sessionId: string };

    // First consumer drains everything (engine completes).
    const initial = await drain(await app.request(`/v1/sessions/${sessionId}/events`));
    expect(initial.length).toBeGreaterThanOrEqual(5);
    const lastId = initial[initial.length - 1]?.id;
    expect(lastId).toBeDefined();

    // Late joiner with Last-Event-ID set to a mid-stream id.
    const lateRes = await app.request(`/v1/sessions/${sessionId}/events`, {
      headers: { "Last-Event-ID": "2" },
    });
    const late = await drain(lateRes);

    // Got only ids 3,4,...  (skipped 0,1,2)
    expect(late.length).toBeGreaterThan(0);
    for (const ev of late) expect(Number(ev.id)).toBeGreaterThan(2);
  });

  it("10 consumers attach at staggered times — all converge on the same final id sequence", async () => {
    // Engine streams events with small delays so consumers attach at different points.
    const engine = new MockEngine([
      { kind: "wait_ms", ms: 10 }, { kind: "emit", payload: { i: 1 } },
      { kind: "wait_ms", ms: 10 }, { kind: "emit", payload: { i: 2 } },
      { kind: "wait_ms", ms: 10 }, { kind: "emit", payload: { i: 3 } },
      { kind: "wait_ms", ms: 10 }, { kind: "emit", payload: { i: 4 } },
      { kind: "wait_ms", ms: 10 }, { kind: "emit", payload: { i: 5 } },
    ]);
    const app = createHarnessServer({
      engines: { mock: engine },
      identityLoaders: { mock: new MockLoader({ metadata: { name: "t", version: "0" } }) },
    });
    const create = await app.request("/v1/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(baseBody),
    });
    const { sessionId } = (await create.json()) as { sessionId: string };

    // Stagger 10 consumer attachments.
    const drains: Promise<ParsedEvent[]>[] = [];
    for (let i = 0; i < 10; i++) {
      drains.push(
        new Promise<ParsedEvent[]>((resolve) => {
          setTimeout(async () => {
            const res = await app.request(`/v1/sessions/${sessionId}/events`);
            resolve(await drain(res));
          }, i * 5);
        }),
      );
    }
    const results = await Promise.all(drains);

    // Every consumer eventually sees the SAME id sequence (full replay from buffer).
    const ref = results[0]!;
    for (const got of results.slice(1)) {
      expect(got.map((e) => e.id)).toEqual(ref.map((e) => e.id));
    }
  });
});
