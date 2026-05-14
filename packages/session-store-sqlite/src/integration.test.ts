/**
 * Integration: drive a real harness-server with SqliteSessionStore wired
 * through the registry, and run the same flows that exercise Memory / File
 * stores in harness-server's own tests. If this passes, the SessionStore
 * contract is genuinely substitutable (LSP gate).
 *
 * This is the test the conformance-suite philosophy was built for — a
 * THIRD-PARTY store implementation that follows only the published port
 * contract, validated against the framework with no special accommodation.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHarnessServer } from "@computeragent/harness-server";
import { MockEngine, MockLoader, collectSseEvents } from "@computeragent/testing";
import { SqliteSessionStore } from "./sqlite-store.js";

let dir: string;
let dbPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ca-sqlite-int-"));
  dbPath = join(dir, "sessions.sqlite");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const baseBody = (extra: Record<string, unknown> = {}) => ({
  engine: "mock",
  identity: { loader: "mock", source: { type: "local", path: "/tmp" } },
  sessionStore: { kind: "sqlite", options: { path: dbPath } },
  ...extra,
});

function makeApp(engine: MockEngine, store?: SqliteSessionStore) {
  return createHarnessServer({
    engines: { mock: engine },
    identityLoaders: { mock: new MockLoader({ metadata: { name: "t", version: "0" } }) },
    sessionStores: {
      sqlite: (options) => store ?? new SqliteSessionStore(options as { path: string }),
    },
  });
}

describe("SqliteSessionStore integration via the harness registry", () => {
  it("registers via sessionStores: { sqlite: ... } and round-trips entries", async () => {
    const engine = new MockEngine([
      { kind: "emit", payload: { type: "assistant", uuid: "u1", text: "hi" } },
      { kind: "emit", payload: { type: "assistant", uuid: "u2", text: "bye" } },
    ]);
    const app = makeApp(engine);
    const create = await app.request("/v1/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(baseBody()),
    });
    expect(create.status).toBe(201);
    const { sessionId } = (await create.json()) as { sessionId: string };
    const res = await app.request(`/v1/sessions/${sessionId}/events`);
    await collectSseEvents(res.body!);

    // Verify the store has the expected number of entries.
    const probe = new SqliteSessionStore({ path: dbPath });
    expect(probe.size(sessionId)).toBe(2);
    probe.close();
  });

  it("LSP gate: cross-process resume — second harness against the same SQLite file sees prior entries", async () => {
    const engine1 = new MockEngine([
      { kind: "emit", payload: { type: "assistant", uuid: "first-1", text: "alpha" } },
    ]);
    const app1 = makeApp(engine1);
    const create1 = await app1.request("/v1/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(baseBody()),
    });
    const { sessionId } = (await create1.json()) as { sessionId: string };
    const ev1 = await app1.request(`/v1/sessions/${sessionId}/events`);
    await collectSseEvents(ev1.body!);

    // Fresh engine + fresh harness — same SQLite file path.
    const engine2 = new MockEngine([
      { kind: "emit", payload: { type: "assistant", uuid: "second-1", text: "beta" } },
    ]);
    const app2 = makeApp(engine2);
    const create2 = await app2.request("/v1/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(baseBody({ sessionId })),
    });
    expect(create2.status).toBe(201);
    const ev2 = await app2.request(`/v1/sessions/${sessionId}/events`);
    await collectSseEvents(ev2.body!);

    // The new MockEngine's load() observed the prior turn's entries.
    expect(engine2.received.loadedEntries).not.toBeNull();
    expect(engine2.received.loadedEntries).toHaveLength(1);
    const loaded = engine2.received.loadedEntries![0] as { payload: { text: string } };
    expect(loaded.payload.text).toBe("alpha");
  });

  it("unknown store kind still surfaces 400 UNKNOWN_STORE — registry doesn't pollute", async () => {
    const engine = new MockEngine([{ kind: "emit", payload: {} }]);
    const app = makeApp(engine);
    const res = await app.request("/v1/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(baseBody({ sessionStore: { kind: "no-such" } })),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; details?: { available?: string[] } } };
    expect(body.error.code).toBe("UNKNOWN_STORE");
    expect(body.error.details?.available?.sort()).toEqual(["file", "memory", "sqlite"]);
  });
});
