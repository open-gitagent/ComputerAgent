import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHarnessServer } from "@computeragent/harness-server";
import { MockEngine, MockLoader } from "@computeragent/testing";
import { ComputerAgent } from "./computer-agent.js";
import { runTask } from "./run-task.js";
import type { BootHarnessOptions, BootedHarness, Substrate } from "./substrate.js";

let serverHandle: { stop: () => void; url: string } | undefined;

async function bootServer(engine: MockEngine) {
  const { serve } = await import("@hono/node-server");
  const app = createHarnessServer({
    engines: { mock: engine },
    identityLoaders: { mock: new MockLoader({ metadata: { name: "test-agent", version: "0.1.0" } }) },
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

beforeEach(() => { serverHandle = undefined; });
afterEach(() => { serverHandle?.stop(); });

describe("runTask — one-shot helper", () => {
  it("runs a task to completion and returns the ChatResult", async () => {
    const engine = new MockEngine([
      { kind: "emit", payload: { type: "assistant", text: "hello" } },
      { kind: "emit", payload: { type: "result", text: "done" } },
    ]);
    serverHandle = await bootServer(engine);

    const result = await runTask({
      source: { type: "local", path: "/tmp" },
      harness: "mock",
      identityLoader: "mock",
      harnessUrl: serverHandle.url,
      message: "do the thing",
    });
    expect(result.sessionId).toMatch(/^sess_/);
    expect(result.messages.length).toBeGreaterThanOrEqual(2);
    expect(result.ended.reason).toBe("complete");
  });

  it("calls substrate.shutdown() even when the task throws", async () => {
    // Use a substrate that boots successfully but the server is unreachable
    // so the chat fetch fails — we still want shutdown to be called.
    let shutdownCalls = 0;
    const fakeSubstrate: Substrate = {
      async bootHarness(_opts: BootHarnessOptions): Promise<BootedHarness> {
        return {
          baseUrl: "http://127.0.0.1:1",  // intentionally unreachable
          shutdown: async () => { shutdownCalls += 1; },
        };
      },
    };

    await expect(runTask({
      source: { type: "local", path: "/tmp" },
      harness: "mock",
      identityLoader: "mock",
      runtime: fakeSubstrate,
      message: "this will fail to reach the server",
    })).rejects.toThrow();

    expect(shutdownCalls).toBe(1);
  });

  it("disposes the substrate after a successful run", async () => {
    const engine = new MockEngine([{ kind: "emit", payload: { type: "result", text: "ok" } }]);
    serverHandle = await bootServer(engine);
    const url = serverHandle.url;

    let shutdownCalls = 0;
    const passthroughSubstrate: Substrate = {
      async bootHarness(): Promise<BootedHarness> {
        return {
          baseUrl: url,
          shutdown: async () => { shutdownCalls += 1; },
        };
      },
    };

    const result = await runTask({
      source: { type: "local", path: "/tmp" },
      harness: "mock",
      identityLoader: "mock",
      runtime: passthroughSubstrate,
      message: "go",
    });
    expect(result.ended.reason).toBe("complete");
    expect(shutdownCalls).toBe(1);
  });
});

describe("ComputerAgent — `await using` / Symbol.asyncDispose", () => {
  it("dispose() is called at end of `await using` scope", async () => {
    const engine = new MockEngine([{ kind: "emit", payload: { type: "result", text: "ok" } }]);
    serverHandle = await bootServer(engine);
    const url = serverHandle.url;

    let shutdownCalls = 0;
    const passthroughSubstrate: Substrate = {
      async bootHarness(): Promise<BootedHarness> {
        return {
          baseUrl: url,
          shutdown: async () => { shutdownCalls += 1; },
        };
      },
    };

    async function runInScope(): Promise<void> {
      await using agent = new ComputerAgent({
        source: { type: "local", path: "/tmp" },
        harness: "mock",
        identityLoader: "mock",
        runtime: passthroughSubstrate,
      });
      const result = await agent.chat("hi");
      expect(result.ended.reason).toBe("complete");
    }

    await runInScope();
    expect(shutdownCalls).toBe(1);
  });
});
