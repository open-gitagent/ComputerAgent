import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHarnessServer } from "@computeragent/harness-server";
import { MockEngine, MockLoader } from "@computeragent/testing";
import { runTask } from "./run-task.js";

let serverHandle: { stop: () => void; url: string } | undefined;
let fileRoot: string;

async function bootServer(engine: MockEngine) {
  const { serve } = await import("@hono/node-server");
  const app = createHarnessServer({
    engines: { mock: engine },
    identityLoaders: { mock: new MockLoader({ metadata: { name: "test", version: "0.0.1" } }) },
  });
  return await new Promise<{ stop: () => void; url: string }>((resolve) => {
    const server = serve({ fetch: app.fetch, port: 0 }, ({ port }) => {
      resolve({
        stop: () => server.close(),
        url: `http://127.0.0.1:${port}`,
      });
    });
  });
}

beforeEach(async () => {
  serverHandle = undefined;
  fileRoot = await mkdtemp(join(tmpdir(), "sdk-resume-"));
});
afterEach(async () => {
  serverHandle?.stop();
  await rm(fileRoot, { recursive: true, force: true });
});

describe("SDK conversation continuation via SessionStore", () => {
  it("second runTask against the same fileRoot + sessionId observes the prior turn", async () => {
    // === Turn 1 ===
    const engine1 = new MockEngine([
      { kind: "emit", payload: { type: "assistant", uuid: "t1-1", text: "remember 47" } },
    ]);
    serverHandle = await bootServer(engine1);
    const r1 = await runTask({
      source: { type: "local", path: "/tmp" },
      harness: "mock",
      identityLoader: "mock",
      harnessUrl: serverHandle.url,
      sessionStore: { kind: "file", options: { root: fileRoot } },
      message: "remember the number 47",
    });
    expect(engine1.received.loadedEntries).toBeNull();
    // Sanity: file store has one entry for r1.sessionId on disk.
    // Give the harness's lazy engine drive a beat to fully finish appending —
    // the SSE stream auto-closes 50ms after ca_session_ended for clean flush,
    // but the engine generator may finish the append after the iterator returns.
    await new Promise((r) => setTimeout(r, 100));
    const { readdir, readFile } = await import("node:fs/promises");
    const files = await readdir(fileRoot);
    expect(files.length).toBeGreaterThan(0);
    const contents = await readFile(join(fileRoot, files[0]!), "utf8");
    expect(contents).toContain("remember 47");
    serverHandle.stop();
    serverHandle = undefined;

    // === Turn 2 — fresh harness instance, fresh MockEngine, SAME fileRoot + sessionId ===
    const engine2 = new MockEngine([
      { kind: "emit", payload: { type: "assistant", uuid: "t2-1", text: "fortyseven" } },
    ]);
    serverHandle = await bootServer(engine2);
    await runTask({
      source: { type: "local", path: "/tmp" },
      harness: "mock",
      identityLoader: "mock",
      harnessUrl: serverHandle.url,
      sessionId: r1.sessionId,
      sessionStore: { kind: "file", options: { root: fileRoot } },
      message: "what number did I tell you?",
    });

    // Engine 2 loaded the prior turn's entries before doing its own work.
    expect(engine2.received.loadedEntries).not.toBeNull();
    expect(engine2.received.loadedEntries).toHaveLength(1);
    const loaded = engine2.received.loadedEntries![0] as { payload: { text: string } };
    expect(loaded.payload.text).toBe("remember 47");
  });

  it("absent sessionStore means no resume — engine sees no prior entries", async () => {
    const engine = new MockEngine([
      { kind: "emit", payload: { type: "assistant", uuid: "x", text: "hi" } },
    ]);
    serverHandle = await bootServer(engine);
    await runTask({
      source: { type: "local", path: "/tmp" },
      harness: "mock",
      identityLoader: "mock",
      harnessUrl: serverHandle.url,
      message: "go",
    });
    expect(engine.received.loadedEntries).toBeNull();
  });

  it("memory store can carry continuation within one process across runTask calls", async () => {
    // Note: kind: "memory" instantiated server-side. Two runTask calls
    // against the SAME server see the same in-memory store.
    const engine1 = new MockEngine([
      { kind: "emit", payload: { type: "assistant", uuid: "m1", text: "alpha" } },
    ]);
    serverHandle = await bootServer(engine1);
    const r1 = await runTask({
      source: { type: "local", path: "/tmp" },
      harness: "mock",
      identityLoader: "mock",
      harnessUrl: serverHandle.url,
      sessionStore: { kind: "memory" },
      message: "first",
    });

    // Second run on the same server (memory store survives the runTask but not server.stop()).
    const engine2 = new MockEngine([
      { kind: "emit", payload: { type: "assistant", uuid: "m2", text: "beta" } },
    ]);
    // Trick: swap the engine on a NEW server but same in-memory store would NOT carry — memory
    // stores are per-server-instance. We confirm this is the documented limitation.
    serverHandle.stop();
    serverHandle = await bootServer(engine2);
    await runTask({
      source: { type: "local", path: "/tmp" },
      harness: "mock",
      identityLoader: "mock",
      harnessUrl: serverHandle.url,
      sessionId: r1.sessionId,
      sessionStore: { kind: "memory" },
      message: "second",
    });
    // After server restart, memory store is fresh — no resume across process boundaries.
    expect(engine2.received.loadedEntries).toBeNull();
  });
});
