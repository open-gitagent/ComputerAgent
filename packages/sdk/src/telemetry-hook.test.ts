/**
 * Verifies the AgentTelemetry lifecycle hooks fire correctly from the SDK.
 * Uses MockEngine + an in-process harness server (the same pattern as
 * computer-agent.test.ts) so this runs in CI offline — no Anthropic, no
 * Mongo. A throwing telemetry impl must NOT break a chat (safeFireTelemetry).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHarnessServer } from "@computeragent/harness-server";
import { MockEngine, MockLoader } from "@computeragent/testing";
import { ComputerAgent } from "./computer-agent.js";
import type {
  AgentConstructedInfo,
  AgentTelemetry,
  ChatEndInfo,
  ChatStartInfo,
} from "./telemetry.js";

interface RecordingTelemetry extends AgentTelemetry {
  readonly events: Array<{ kind: string; info?: unknown; returnedCtx?: unknown }>;
}

function makeRecorder(): RecordingTelemetry {
  const events: RecordingTelemetry["events"] = [];
  return {
    events,
    onAgentConstructed(info: AgentConstructedInfo) {
      events.push({ kind: "constructed", info });
    },
    onChatStart(info: ChatStartInfo) {
      const ctx = { startedAt: Date.now(), msg: info.message };
      events.push({ kind: "start", info, returnedCtx: ctx });
      return ctx;
    },
    onChatEnd(info: ChatEndInfo) {
      events.push({ kind: "end", info });
    },
    onClose() {
      events.push({ kind: "close" });
    },
  };
}

let serverHandle: { stop: () => void; url: string } | undefined;

async function bootServer(engine: MockEngine) {
  const { serve } = await import("@hono/node-server");
  const app = createHarnessServer({
    engines: { mock: engine },
    identityLoaders: {
      mock: new MockLoader({ metadata: { name: "test-agent", version: "0.1.0" } }),
    },
  });
  return await new Promise<{ stop: () => void; url: string }>((resolve) => {
    const server = serve({ fetch: app.fetch, port: 0 }, ({ port }) => {
      resolve({ stop: () => server.close(), url: `http://127.0.0.1:${port}` });
    });
  });
}

beforeEach(() => {
  serverHandle = undefined;
});

afterEach(() => {
  serverHandle?.stop();
});

describe("AgentTelemetry — lifecycle hooks fire", () => {
  it("fires onAgentConstructed once with source/harness/model", async () => {
    const engine = new MockEngine([
      { kind: "emit", payload: { type: "result", text: "done" } },
    ]);
    serverHandle = await bootServer(engine);
    const telemetry = makeRecorder();

    const _agent = new ComputerAgent({
      source: { type: "local", path: "/tmp/spike" },
      harness: "mock",
      identityLoader: "mock",
      harnessUrl: serverHandle.url,
      model: "claude-haiku-4-5",
      telemetry,
    });

    // onAgentConstructed fires synchronously from the constructor (fire-and-
    // forget), so by the next microtask tick the event is recorded.
    await new Promise((r) => setTimeout(r, 5));
    const constructed = telemetry.events.find((e) => e.kind === "constructed");
    expect(constructed).toBeDefined();
    const info = constructed!.info as AgentConstructedInfo;
    expect(info.harness).toBe("mock");
    expect(info.model).toBe("claude-haiku-4-5");
    expect(info.source).toEqual({ type: "local", path: "/tmp/spike" });
  });

  it("fires onChatStart → onChatEnd with the context threaded between them (success path)", async () => {
    const engine = new MockEngine([
      { kind: "emit", payload: { type: "assistant", text: "hi" } },
      { kind: "emit", payload: { type: "result", text: "done" } },
    ]);
    serverHandle = await bootServer(engine);
    const telemetry = makeRecorder();

    const agent = new ComputerAgent({
      source: { type: "local", path: "/tmp" },
      harness: "mock",
      identityLoader: "mock",
      harnessUrl: serverHandle.url,
      telemetry,
    });

    await agent.chat("hello world");
    // Telemetry is fire-and-forget — flush microtasks so onChatEnd lands.
    await new Promise((r) => setTimeout(r, 20));

    const start = telemetry.events.find((e) => e.kind === "start");
    const end = telemetry.events.find((e) => e.kind === "end");
    expect(start).toBeDefined();
    expect(end).toBeDefined();

    const startInfo = start!.info as ChatStartInfo;
    expect(startInfo.message).toBe("hello world");
    expect(startInfo.sessionIdPromise).toBeInstanceOf(Promise);

    const endInfo = end!.info as ChatEndInfo;
    expect(endInfo.ok).toBe(true);
    expect(endInfo.context).toEqual(start!.returnedCtx);
    expect(endInfo.sessionId).toMatch(/^sess_/);
    expect(typeof endInfo.durationMs).toBe("number");
    expect(endInfo.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("fires onChatEnd with ok=false + error when the chat fails", async () => {
    // No harness URL = the SDK's first /v1/sessions call will fail with a
    // connect error, which surfaces through ChatHandle.then's reject branch.
    const telemetry = makeRecorder();

    const agent = new ComputerAgent({
      source: { type: "local", path: "/tmp" },
      harness: "mock",
      identityLoader: "mock",
      harnessUrl: "http://127.0.0.1:1", // port 1 — guaranteed connect refused
      telemetry,
    });

    await expect(agent.chat("doomed")).rejects.toBeDefined();
    await new Promise((r) => setTimeout(r, 30));

    const end = telemetry.events.find((e) => e.kind === "end");
    expect(end).toBeDefined();
    const endInfo = end!.info as ChatEndInfo;
    expect(endInfo.ok).toBe(false);
    expect(endInfo.error).toBeDefined();
    expect(typeof endInfo.error).toBe("string");
  });

  it("fires onClose on dispose()", async () => {
    const engine = new MockEngine([
      { kind: "emit", payload: { type: "result", text: "done" } },
    ]);
    serverHandle = await bootServer(engine);
    const telemetry = makeRecorder();

    const agent = new ComputerAgent({
      source: { type: "local", path: "/tmp" },
      harness: "mock",
      identityLoader: "mock",
      harnessUrl: serverHandle.url,
      telemetry,
    });

    await agent.dispose();
    await new Promise((r) => setTimeout(r, 10));

    expect(telemetry.events.some((e) => e.kind === "close")).toBe(true);
  });

  it("a throwing telemetry impl does NOT break a chat (safeFireTelemetry)", async () => {
    const engine = new MockEngine([
      { kind: "emit", payload: { type: "assistant", text: "ok" } },
      { kind: "emit", payload: { type: "result", text: "done" } },
    ]);
    serverHandle = await bootServer(engine);

    const throwing: AgentTelemetry = {
      onAgentConstructed() {
        throw new Error("boom in constructed");
      },
      onChatStart() {
        throw new Error("boom in start");
      },
      onChatEnd() {
        throw new Error("boom in end");
      },
      onClose() {
        throw new Error("boom in close");
      },
    };

    const agent = new ComputerAgent({
      source: { type: "local", path: "/tmp" },
      harness: "mock",
      identityLoader: "mock",
      harnessUrl: serverHandle.url,
      telemetry: throwing,
    });

    // The chat must succeed despite every telemetry hook throwing.
    const result = await agent.chat("survive");
    expect(result.sessionId).toMatch(/^sess_/);

    await agent.dispose();
    // No exception should have propagated.
  });

  it("an async-rejecting telemetry impl also doesn't break the chat", async () => {
    const engine = new MockEngine([
      { kind: "emit", payload: { type: "result", text: "done" } },
    ]);
    serverHandle = await bootServer(engine);

    const rejecting: AgentTelemetry = {
      onAgentConstructed: async () => {
        throw new Error("async boom constructed");
      },
      onChatStart: () => undefined,
      onChatEnd: async () => {
        throw new Error("async boom end");
      },
      onClose: async () => {
        throw new Error("async boom close");
      },
    };

    const agent = new ComputerAgent({
      source: { type: "local", path: "/tmp" },
      harness: "mock",
      identityLoader: "mock",
      harnessUrl: serverHandle.url,
      telemetry: rejecting,
    });

    const result = await agent.chat("survive async");
    expect(result.sessionId).toMatch(/^sess_/);
    await agent.dispose();
    // No unhandled rejection should crash the test runner.
  });

  it("agent without a telemetry option works exactly as before (no hooks fire)", async () => {
    const engine = new MockEngine([
      { kind: "emit", payload: { type: "result", text: "done" } },
    ]);
    serverHandle = await bootServer(engine);

    const agent = new ComputerAgent({
      source: { type: "local", path: "/tmp" },
      harness: "mock",
      identityLoader: "mock",
      harnessUrl: serverHandle.url,
      // no telemetry
    });

    const result = await agent.chat("plain");
    expect(result.sessionId).toMatch(/^sess_/);
    await agent.dispose();
    // Nothing to assert on the (absent) telemetry — the test passes as long
    // as construction + chat + dispose don't error. Regression guard for the
    // hook-wiring branches.
  });
});
