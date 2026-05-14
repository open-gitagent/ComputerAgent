import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockEngine, MockLoader, collectSseEvents } from "@computeragent/testing";
import { createHarnessServer } from "./app.js";
import { MemorySessionStore } from "./stores/memory-store.js";

function makeApp(opts: {
  engine: MockEngine;
  memoryStore?: MemorySessionStore;
  fileRoot?: string;
} = {} as never) {
  return createHarnessServer({
    engines: { mock: opts.engine },
    identityLoaders: { mock: new MockLoader({ metadata: { name: "test", version: "0.0.1" } }) },
    sessionStores: opts.memoryStore ? { memory: () => opts.memoryStore! } : undefined,
  });
}

const body = (extra: Record<string, unknown> = {}) => ({
  engine: "mock",
  identity: { loader: "mock", source: { type: "local", path: "/tmp" } },
  ...extra,
});

describe("SessionStore integration via POST /v1/sessions", () => {
  it("MockEngine receives ctx.sessionStore and calls load() + append() through it", async () => {
    const store = new MemorySessionStore();
    const engine = new MockEngine([
      { kind: "emit", payload: { type: "assistant", uuid: "u1", text: "hi" } },
      { kind: "emit", payload: { type: "assistant", uuid: "u2", text: "bye" } },
    ]);
    const app = makeApp({ engine, memoryStore: store });

    const create = await app.request("/v1/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body({ sessionStore: { kind: "memory" } })),
    });
    const { sessionId } = (await create.json()) as { sessionId: string };
    const res = await app.request(`/v1/sessions/${sessionId}/events`);
    await collectSseEvents(res.body!);

    // First-turn load — store is empty, MockEngine recorded null.
    expect(engine.received.loadedEntries).toBeNull();
    // Each emit appended to the store.
    expect(store.size(sessionId)).toBe(2);
  });

  it("unknown store kind returns 400 UNKNOWN_STORE with available list", async () => {
    const engine = new MockEngine([{ kind: "emit", payload: {} }]);
    const app = makeApp({ engine });
    const res = await app.request("/v1/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body({ sessionStore: { kind: "no-such-store" } })),
    });
    expect(res.status).toBe(400);
    const errBody = (await res.json()) as { error: { code: string; details?: { available?: string[] } } };
    expect(errBody.error.code).toBe("UNKNOWN_STORE");
    expect(errBody.error.details?.available?.sort()).toEqual(["file", "memory"]);
  });

  it("passing sessionStore without a runtime/store config still works (no store wired)", async () => {
    const engine = new MockEngine([{ kind: "emit", payload: {} }]);
    const app = makeApp({ engine });
    const create = await app.request("/v1/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body()),
    });
    expect(create.status).toBe(201);
    // Engine never saw a store.
    const { sessionId } = (await create.json()) as { sessionId: string };
    const res = await app.request(`/v1/sessions/${sessionId}/events`);
    await collectSseEvents(res.body!);
    expect(engine.received.loadedEntries).toBeNull();
  });
});

describe("Resume across process-restart (the load-bearing test)", () => {
  let fileRoot: string;

  beforeEach(async () => {
    fileRoot = await mkdtemp(join(tmpdir(), "session-resume-"));
  });
  afterEach(async () => {
    await rm(fileRoot, { recursive: true, force: true });
  });

  it("a second harness instance against the same FileStore root sees the prior transcript", async () => {
    // === First "process": create a session, run a turn, dispose ===
    const engine1 = new MockEngine([
      { kind: "emit", payload: { type: "assistant", uuid: "first-turn-1", text: "first" } },
    ]);
    const app1 = createHarnessServer({
      engines: { mock: engine1 },
      identityLoaders: { mock: new MockLoader({ metadata: { name: "t", version: "0" } }) },
    });
    const create1 = await app1.request("/v1/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body({
        sessionStore: { kind: "file", options: { root: fileRoot } },
      })),
    });
    const { sessionId } = (await create1.json()) as { sessionId: string };
    const events1 = await app1.request(`/v1/sessions/${sessionId}/events`);
    await collectSseEvents(events1.body!);
    expect(engine1.received.loadedEntries).toBeNull(); // first turn → empty store

    // === Second "process": brand new harness + new MockEngine, SAME fileRoot + sessionId ===
    const engine2 = new MockEngine([
      { kind: "emit", payload: { type: "assistant", uuid: "second-turn-1", text: "second" } },
    ]);
    const app2 = createHarnessServer({
      engines: { mock: engine2 },
      identityLoaders: { mock: new MockLoader({ metadata: { name: "t", version: "0" } }) },
    });
    const create2 = await app2.request("/v1/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body({
        sessionId,
        sessionStore: { kind: "file", options: { root: fileRoot } },
      })),
    });
    expect(create2.status).toBe(201);
    const events2 = await app2.request(`/v1/sessions/${sessionId}/events`);
    await collectSseEvents(events2.body!);

    // The new engine instance saw the prior transcript via load().
    expect(engine2.received.loadedEntries).not.toBeNull();
    expect(engine2.received.loadedEntries).toHaveLength(1);
    expect((engine2.received.loadedEntries![0] as { payload: { text: string } }).payload.text).toBe("first");
  });

  it("explicit sessionId override is honored when supplied by the client", async () => {
    const engine = new MockEngine([{ kind: "emit", payload: { type: "x" } }]);
    const app = createHarnessServer({
      engines: { mock: engine },
      identityLoaders: { mock: new MockLoader({ metadata: { name: "t", version: "0" } }) },
    });
    const create = await app.request("/v1/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body({ sessionId: "my-fixed-id" })),
    });
    const { sessionId } = (await create.json()) as { sessionId: string };
    expect(sessionId).toBe("my-fixed-id");
  });
});
