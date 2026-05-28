import { describe, expect, it } from "vitest";
import type { SessionKey, SessionStore, SessionStoreEntry } from "@open-gitagent/protocol";
import { MockEngine, MockLoader, collectSseEvents } from "@computeragent/testing";
import { createHarnessServer } from "./app.js";

class HalfGarbageStore implements SessionStore {
  appended: SessionStoreEntry[] = [];
  async load(_k: SessionKey): Promise<SessionStoreEntry[] | null> {
    return [
      { type: "valid", uuid: "ok1", text: "real" },
      { broken: true, no: "type-field" } as never,
      { type: "", empty: true } as never,
      { type: "valid", uuid: "ok2", text: "another" },
      42 as never,
    ];
  }
  async append(_k: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
    this.appended.push(...entries);
  }
}

const baseBody = {
  engine: "mock",
  identity: { loader: "mock", source: { type: "local", path: "/tmp" } },
  sessionStore: { kind: "garbage" },
};

describe("createHarnessServer({ validateStoreEntries }) — end-to-end", () => {
  it("OFF (default): engine sees ALL entries, including malformed ones", async () => {
    const store = new HalfGarbageStore();
    const engine = new MockEngine([{ kind: "emit", payload: { type: "x" } }]);
    const app = createHarnessServer({
      engines: { mock: engine },
      identityLoaders: { mock: new MockLoader({ metadata: { name: "t", version: "0" } }) },
      sessionStores: { garbage: () => store },
    });
    const create = await app.request("/v1/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(baseBody),
    });
    const { sessionId } = (await create.json()) as { sessionId: string };
    const res = await app.request(`/v1/sessions/${sessionId}/events`);
    await collectSseEvents(res.body!);
    expect(engine.received.loadedEntries).toHaveLength(5);
  });

  it("ON: engine sees only entries that pass the contract — malformed dropped", async () => {
    const store = new HalfGarbageStore();
    const engine = new MockEngine([{ kind: "emit", payload: { type: "x" } }]);
    const app = createHarnessServer({
      engines: { mock: engine },
      identityLoaders: { mock: new MockLoader({ metadata: { name: "t", version: "0" } }) },
      sessionStores: { garbage: () => store },
      validateStoreEntries: true,
    });
    const create = await app.request("/v1/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(baseBody),
    });
    const { sessionId } = (await create.json()) as { sessionId: string };
    const res = await app.request(`/v1/sessions/${sessionId}/events`);
    await collectSseEvents(res.body!);
    // Only the two well-formed entries should reach the engine.
    expect(engine.received.loadedEntries).toHaveLength(2);
    expect(
      (engine.received.loadedEntries as { type: string }[]).every((e) => e.type === "valid"),
    ).toBe(true);
  });

  it("ON: append() still passes through unchanged — validation is read-only", async () => {
    const store = new HalfGarbageStore();
    const engine = new MockEngine([
      { kind: "emit", payload: { type: "assistant", uuid: "u1", text: "ok" } },
    ]);
    const app = createHarnessServer({
      engines: { mock: engine },
      identityLoaders: { mock: new MockLoader({ metadata: { name: "t", version: "0" } }) },
      sessionStores: { garbage: () => store },
      validateStoreEntries: true,
    });
    const create = await app.request("/v1/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(baseBody),
    });
    const { sessionId } = (await create.json()) as { sessionId: string };
    const res = await app.request(`/v1/sessions/${sessionId}/events`);
    await collectSseEvents(res.body!);
    // MockEngine appends 1 entry per emit; verify it landed in the store.
    expect(store.appended).toHaveLength(1);
  });
});
