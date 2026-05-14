/**
 * Stress: many concurrent sessions in flight at once. Production concern —
 * an agent farm or batch job spawning N sessions in parallel must not
 * corrupt the session registry, the sessionStore, or each other's events.
 */
import { describe, expect, it } from "vitest";
import { MockEngine, MockLoader, collectSseEvents } from "@computeragent/testing";
import { createHarnessServer } from "./app.js";
import { MemorySessionStore } from "./stores/memory-store.js";

const baseBody = {
  engine: "mock",
  identity: { loader: "mock", source: { type: "local", path: "/tmp" } },
};

describe("Stress: concurrent session creation + drive", () => {
  it("20 sessions in parallel — each gets a unique sessionId, each store key isolated", async () => {
    const sharedStore = new MemorySessionStore();
    const engine = new MockEngine([
      { kind: "wait_ms", ms: 10 },
      { kind: "emit", payload: { type: "assistant", uuid: "u", text: "ok" } },
    ]);
    const app = createHarnessServer({
      engines: { mock: engine },
      identityLoaders: { mock: new MockLoader({ metadata: { name: "t", version: "0" } }) },
      sessionStores: { shared: () => sharedStore },
    });

    // Fire 20 create-and-drive flows concurrently.
    const runs = Array.from({ length: 20 }, async () => {
      const create = await app.request("/v1/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...baseBody, sessionStore: { kind: "shared" } }),
      });
      const { sessionId } = (await create.json()) as { sessionId: string };
      const res = await app.request(`/v1/sessions/${sessionId}/events`);
      const events = await collectSseEvents(res.body!);
      return { sessionId, events };
    });
    const results = await Promise.all(runs);

    // Every sessionId is unique.
    const ids = results.map((r) => r.sessionId);
    expect(new Set(ids).size).toBe(20);

    // Every session ended cleanly.
    for (const r of results) {
      const ended = r.events[r.events.length - 1] as { kind: string; reason?: string };
      expect(ended.kind).toBe("ca_session_ended");
      expect(ended.reason).toBe("complete");
    }

    // The shared store has each sessionId as its own bucket — exactly 1 entry per session.
    for (const id of ids) {
      expect(sharedStore.size(id)).toBe(1);
    }
  });

  it("20 sessions × 5 SSE consumers each = 100 concurrent streams — no event drift across sessions", async () => {
    const engine = new MockEngine([
      { kind: "wait_ms", ms: 5 },
      { kind: "emit", payload: { type: "system" } },
      { kind: "wait_ms", ms: 5 },
      { kind: "emit", payload: { type: "assistant", text: "a" } },
      { kind: "wait_ms", ms: 5 },
      { kind: "emit", payload: { type: "result", text: "done" } },
    ]);
    const app = createHarnessServer({
      engines: { mock: engine },
      identityLoaders: { mock: new MockLoader({ metadata: { name: "t", version: "0" } }) },
    });

    const sessionIds: string[] = [];
    for (let i = 0; i < 20; i++) {
      const create = await app.request("/v1/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(baseBody),
      });
      const { sessionId } = (await create.json()) as { sessionId: string };
      sessionIds.push(sessionId);
    }

    // For each session, fire 5 SSE consumers in parallel.
    const allRuns = sessionIds.flatMap((sid) =>
      Array.from({ length: 5 }, async () => {
        const res = await app.request(`/v1/sessions/${sid}/events`);
        const events = await collectSseEvents(res.body!);
        return { sid, ids: events.map((e) => (e as { id?: string }).id), kinds: events.map((e) => e.kind) };
      }),
    );
    const all = await Promise.all(allRuns);

    // Group results by sessionId; every consumer in a group should agree.
    const bySession = new Map<string, typeof all>();
    for (const r of all) {
      const list = bySession.get(r.sid) ?? [];
      list.push(r);
      bySession.set(r.sid, list);
    }
    for (const [, group] of bySession) {
      const ref = group[0]!;
      for (const got of group.slice(1)) {
        expect(got.ids).toEqual(ref.ids);
        expect(got.kinds).toEqual(ref.kinds);
      }
    }
  });
});
