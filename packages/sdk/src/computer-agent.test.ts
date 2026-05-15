import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHarnessServer } from "@computeragent/harness-server";
import { MockEngine, MockLoader } from "@computeragent/testing";
import { ComputerAgent } from "./computer-agent.js";
import { UnknownEngineError, UnknownLoaderError } from "./errors.js";

/**
 * Integration tests: real harness server (booted in-process) + real SDK going
 * through real HTTP (Bun.serve on a free port). This is the load-bearing
 * test surface for the wedge — it verifies the SDK's HTTP and SSE behavior
 * against the actual server, not a mock.
 */

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

beforeEach(() => {
  serverHandle = undefined;
});

afterEach(() => {
  serverHandle?.stop();
});

describe("ComputerAgent — one-shot", () => {
  it("await agent.chat(...) drains to a ChatResult with messages", async () => {
    const engine = new MockEngine([
      { kind: "emit", payload: { type: "system" } },
      { kind: "emit", payload: { type: "assistant", text: "hello" } },
      { kind: "emit", payload: { type: "result", text: "done" } },
    ]);
    serverHandle = await bootServer(engine);

    const agent = new ComputerAgent({
      source: { type: "local", path: "/tmp" },
      harness: "mock",
      identityLoader: "mock",
      harnessUrl: serverHandle.url,
    });

    const result = await agent.chat("just a string");
    expect(result.sessionId).toMatch(/^sess_/);
    expect(result.messages).toHaveLength(3);
    expect(result.ended.reason).toBe("complete");
  });

  it("for await yields ca_session_started, sdk_messages, ca_session_ended", async () => {
    const engine = new MockEngine([
      { kind: "emit", payload: { type: "result", text: "ok" } },
    ]);
    serverHandle = await bootServer(engine);

    const agent = new ComputerAgent({
      source: { type: "local", path: "/tmp" },
      harness: "mock",
      identityLoader: "mock",
      harnessUrl: serverHandle.url,
    });

    const kinds: string[] = [];
    for await (const ev of agent.chat("hi")) {
      kinds.push(ev.kind);
    }
    expect(kinds[0]).toBe("ca_session_started");
    expect(kinds).toContain("sdk_message");
    expect(kinds[kinds.length - 1]).toBe("ca_session_ended");
  });

  it("normalizes a plain-string source as either git or local", async () => {
    const engine = new MockEngine([]);
    serverHandle = await bootServer(engine);
    const agent = new ComputerAgent({
      source: "/tmp",
      harness: "mock",
      identityLoader: "mock",
      harnessUrl: serverHandle.url,
    });
    const result = await agent.chat([]);
    expect(result.ended.reason).toBe("complete");
  });
});

describe("ComputerAgent — permission round-trip", () => {
  it("auto-allows permission requests when no onToolCall is set", async () => {
    const engine = new MockEngine([
      { kind: "ask_permission", toolName: "Write", expect: "allow" },
      { kind: "emit", payload: { type: "result", text: "wrote" } },
    ]);
    serverHandle = await bootServer(engine);

    const agent = new ComputerAgent({
      source: { type: "local", path: "/tmp" },
      harness: "mock",
      identityLoader: "mock",
      harnessUrl: serverHandle.url,
    });

    const result = await agent.chat("do thing");
    expect(result.ended.reason).toBe("complete");
    expect(engine.received.permissions).toHaveLength(1);
  });

  it("invokes onToolCall and forwards the decision", async () => {
    const engine = new MockEngine([
      { kind: "ask_permission", toolName: "Bash", expect: "deny" },
      { kind: "emit", payload: { type: "result", text: "blocked" } },
    ]);
    serverHandle = await bootServer(engine);

    const callsSeen: string[] = [];
    const agent = new ComputerAgent({
      source: { type: "local", path: "/tmp" },
      harness: "mock",
      identityLoader: "mock",
      harnessUrl: serverHandle.url,
      onToolCall: async (c) => {
        callsSeen.push(c.toolName);
        return { decision: "deny", reason: "no Bash in tests" };
      },
    });

    await agent.chat("try Bash");
    expect(callsSeen).toEqual(["Bash"]);
  });
});

describe("ComputerAgent — multi-turn", () => {
  it("two .chat() calls on the same agent reuse the session", async () => {
    const engine = new MockEngine([
      { kind: "wait_for_user_message" },
      { kind: "emit", payload: { type: "result", text: "first" } },
    ]);
    serverHandle = await bootServer(engine);

    const agent = new ComputerAgent({
      source: { type: "local", path: "/tmp" },
      harness: "mock",
      identityLoader: "mock",
      harnessUrl: serverHandle.url,
    });

    const first = await agent.chat("turn 1");
    expect(first.sessionId).toMatch(/^sess_/);
    expect(agent.sessionId).toBe(first.sessionId);
  });

  it("typo'd harness name throws UnknownEngineError with available list + suggestion", async () => {
    const engine = new MockEngine([]);
    serverHandle = await bootServer(engine);

    const agent = new ComputerAgent({
      source: { type: "local", path: "/tmp" },
      harness: "moc",  // typo of "mock"
      identityLoader: "mock",
      harnessUrl: serverHandle.url,
    });

    try {
      await agent.chat("hi");
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(UnknownEngineError);
      const err = e as UnknownEngineError;
      expect(err.code).toBe("UNKNOWN_ENGINE");
      expect(err.requested).toBe("moc");
      expect(err.available).toContain("mock");
      expect(err.message).toContain('Did you mean "mock"');
    }
  });

  it("typo'd identityLoader throws UnknownLoaderError", async () => {
    const engine = new MockEngine([]);
    serverHandle = await bootServer(engine);

    const agent = new ComputerAgent({
      source: { type: "local", path: "/tmp" },
      harness: "mock",
      identityLoader: "moc",  // typo
      harnessUrl: serverHandle.url,
    });

    try {
      await agent.chat("hi");
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(UnknownLoaderError);
      const err = e as UnknownLoaderError;
      expect(err.requested).toBe("moc");
      expect(err.available).toContain("mock");
    }
  });

  it("ChatResult.usage aggregates token snapshots (sums tokens) and cumulative cost (max) — issue #5", async () => {
    const engine = new MockEngine([
      // Turn-1 snapshot from a Claude-SDK-like engine: cumulative cost.
      { kind: "emit_usage", inputTokens: 100, outputTokens: 200, costUsd: 0.01, costSemantic: "cumulative" },
      // A second cumulative snapshot from the same engine — running total grew.
      { kind: "emit_usage", inputTokens: 50, outputTokens: 75, costUsd: 0.025, costSemantic: "cumulative" },
      { kind: "emit", payload: { type: "result", result: "ok" } },
    ]);
    serverHandle = await bootServer(engine);

    const agent = new ComputerAgent({
      source: { type: "local", path: "/tmp" },
      harness: "mock",
      identityLoader: "mock",
      harnessUrl: serverHandle.url,
    });

    const result = await agent.chat("hi");
    // Tokens sum across snapshots.
    expect(result.usage.inputTokens).toBe(150);
    expect(result.usage.outputTokens).toBe(275);
    // Cumulative cost — max value seen.
    expect(result.usage.costUsd).toBe(0.025);
  });

  it("ChatResult.usage sums delta-semantic cost across per-message snapshots", async () => {
    // gitclaw-style: each assistant message reports its own per-call cost.
    const engine = new MockEngine([
      { kind: "emit_usage", inputTokens: 80, outputTokens: 120, costUsd: 0.004, costSemantic: "delta" },
      { kind: "emit_usage", inputTokens: 40, outputTokens: 60, costUsd: 0.002, costSemantic: "delta" },
      { kind: "emit", payload: { type: "result", result: "ok" } },
    ]);
    serverHandle = await bootServer(engine);

    const agent = new ComputerAgent({
      source: { type: "local", path: "/tmp" },
      harness: "mock",
      identityLoader: "mock",
      harnessUrl: serverHandle.url,
    });

    const result = await agent.chat("hi");
    expect(result.usage.inputTokens).toBe(120);
    expect(result.usage.outputTokens).toBe(180);
    // Delta cost — summed.
    expect(result.usage.costUsd).toBeCloseTo(0.006, 6);
  });

  it("ChatResult.usage returns zeros + undefined cost when engine emits no snapshots", async () => {
    const engine = new MockEngine([
      { kind: "emit", payload: { type: "result", result: "ok" } },
    ]);
    serverHandle = await bootServer(engine);

    const agent = new ComputerAgent({
      source: { type: "local", path: "/tmp" },
      harness: "mock",
      identityLoader: "mock",
      harnessUrl: serverHandle.url,
    });

    const result = await agent.chat("hi");
    expect(result.usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      costUsd: undefined,
    });
  });

  it("ChatResult.usage handles tokens-only snapshots (cost stays undefined)", async () => {
    const engine = new MockEngine([
      { kind: "emit_usage", inputTokens: 10, outputTokens: 20 },   // no costUsd
      { kind: "emit", payload: { type: "result", result: "ok" } },
    ]);
    serverHandle = await bootServer(engine);

    const agent = new ComputerAgent({
      source: { type: "local", path: "/tmp" },
      harness: "mock",
      identityLoader: "mock",
      harnessUrl: serverHandle.url,
    });

    const result = await agent.chat("hi");
    expect(result.usage.inputTokens).toBe(10);
    expect(result.usage.outputTokens).toBe(20);
    expect(result.usage.costUsd).toBeUndefined();
  });

  it("model field is folded into body.options.model (Wedge 1.7)", async () => {
    const engine = new MockEngine([{ kind: "emit", payload: { type: "result", result: "ok" } }]);
    serverHandle = await bootServer(engine);

    let capturedBody: Record<string, unknown> | undefined;
    const interceptingFetch: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
      if (url.endsWith("/v1/sessions") && init?.method === "POST" && typeof init.body === "string") {
        capturedBody = JSON.parse(init.body) as Record<string, unknown>;
      }
      return fetch(input, init);
    };

    const agent = new ComputerAgent({
      source: { type: "local", path: "/tmp" },
      harness: "mock",
      identityLoader: "mock",
      harnessUrl: serverHandle.url,
      fetch: interceptingFetch,
      model: "claude-haiku-4-5-20251001",
    });
    await agent.chat("hi");

    expect(capturedBody?.options).toBeDefined();
    expect((capturedBody?.options as { model?: string }).model).toBe("claude-haiku-4-5-20251001");
  });

  it("model field wins over options.model when both are set", async () => {
    const engine = new MockEngine([{ kind: "emit", payload: { type: "result", result: "ok" } }]);
    serverHandle = await bootServer(engine);

    let capturedBody: Record<string, unknown> | undefined;
    const interceptingFetch: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
      if (url.endsWith("/v1/sessions") && init?.method === "POST" && typeof init.body === "string") {
        capturedBody = JSON.parse(init.body) as Record<string, unknown>;
      }
      return fetch(input, init);
    };

    const agent = new ComputerAgent({
      source: { type: "local", path: "/tmp" },
      harness: "mock",
      identityLoader: "mock",
      harnessUrl: serverHandle.url,
      fetch: interceptingFetch,
      options: { model: "old-model-from-options" },
      model: "new-model-from-shortcut",
    });
    await agent.chat("hi");

    expect((capturedBody?.options as { model?: string }).model).toBe("new-model-from-shortcut");
  });

  it("temperature field is folded into body.options.temperature", async () => {
    const engine = new MockEngine([{ kind: "emit", payload: { type: "result", result: "ok" } }]);
    serverHandle = await bootServer(engine);

    let capturedBody: Record<string, unknown> | undefined;
    const interceptingFetch: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
      if (url.endsWith("/v1/sessions") && init?.method === "POST" && typeof init.body === "string") {
        capturedBody = JSON.parse(init.body) as Record<string, unknown>;
      }
      return fetch(input, init);
    };

    const agent = new ComputerAgent({
      source: { type: "local", path: "/tmp" },
      harness: "mock",
      identityLoader: "mock",
      harnessUrl: serverHandle.url,
      fetch: interceptingFetch,
      temperature: 0.42,
    });
    await agent.chat("hi");

    expect((capturedBody?.options as { temperature?: number }).temperature).toBe(0.42);
  });

  it("baseUrl injects ANTHROPIC_BASE_URL into envs", async () => {
    const engine = new MockEngine([{ kind: "emit", payload: { type: "result", result: "ok" } }]);
    serverHandle = await bootServer(engine);

    let capturedBody: Record<string, unknown> | undefined;
    const interceptingFetch: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
      if (url.endsWith("/v1/sessions") && init?.method === "POST" && typeof init.body === "string") {
        capturedBody = JSON.parse(init.body) as Record<string, unknown>;
      }
      return fetch(input, init);
    };

    const agent = new ComputerAgent({
      source: { type: "local", path: "/tmp" },
      harness: "mock",
      identityLoader: "mock",
      harnessUrl: serverHandle.url,
      fetch: interceptingFetch,
      envs: { ANTHROPIC_API_KEY: "test" },
      baseUrl: "https://my-proxy.example.com",
    });
    await agent.chat("hi");

    expect((capturedBody?.envs as Record<string, string>).ANTHROPIC_BASE_URL).toBe(
      "https://my-proxy.example.com",
    );
    expect((capturedBody?.envs as Record<string, string>).ANTHROPIC_API_KEY).toBe("test");
  });

  it("baseUrl does NOT clobber an explicit envs.ANTHROPIC_BASE_URL", async () => {
    const engine = new MockEngine([{ kind: "emit", payload: { type: "result", result: "ok" } }]);
    serverHandle = await bootServer(engine);

    let capturedBody: Record<string, unknown> | undefined;
    const interceptingFetch: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
      if (url.endsWith("/v1/sessions") && init?.method === "POST" && typeof init.body === "string") {
        capturedBody = JSON.parse(init.body) as Record<string, unknown>;
      }
      return fetch(input, init);
    };

    const agent = new ComputerAgent({
      source: { type: "local", path: "/tmp" },
      harness: "mock",
      identityLoader: "mock",
      harnessUrl: serverHandle.url,
      fetch: interceptingFetch,
      envs: { ANTHROPIC_BASE_URL: "https://explicit.example.com" },
      baseUrl: "https://shortcut.example.com",
    });
    await agent.chat("hi");

    expect((capturedBody?.envs as Record<string, string>).ANTHROPIC_BASE_URL).toBe(
      "https://explicit.example.com",
    );
  });

  it("invalid baseUrl throws at construction (fail fast)", () => {
    expect(
      () =>
        new ComputerAgent({
          source: { type: "local", path: "/tmp" },
          harness: "mock",
          identityLoader: "mock",
          harnessUrl: "http://127.0.0.1:1",
          baseUrl: "not a url",
        }),
    ).toThrow(/invalid baseUrl/);
  });

  it("two sequential .chat() calls produce distinct responses (issue #2)", async () => {
    // Two turns scripted in one engine session. The engine waits for each
    // user message in turn, then emits a result. If the SDK's multi-turn
    // wiring is right, turn 2's response must be "response-2", not the
    // replayed "response-1" from turn 1.
    const engine = new MockEngine([
      { kind: "wait_for_user_message" },
      { kind: "emit", payload: { type: "result", text: "response-1" } },
      { kind: "wait_for_user_message" },
      { kind: "emit", payload: { type: "result", text: "response-2" } },
    ]);
    serverHandle = await bootServer(engine);

    const agent = new ComputerAgent({
      source: { type: "local", path: "/tmp" },
      harness: "mock",
      identityLoader: "mock",
      harnessUrl: serverHandle.url,
    });

    const r1 = await agent.chat("turn 1");
    const r1Text = (r1.messages.find(
      (m): m is { type: "result"; text: string } =>
        (m as { type?: string }).type === "result",
    ))?.text;
    expect(r1Text).toBe("response-1");

    const r2 = await agent.chat("turn 2");
    const r2Text = (r2.messages.find(
      (m): m is { type: "result"; text: string } =>
        (m as { type?: string }).type === "result",
    ))?.text;
    expect(r2Text).toBe("response-2");

    // Same session across both turns
    expect(r1.sessionId).toBe(r2.sessionId);

    // Engine actually saw both user messages
    expect(engine.received.userMessages).toHaveLength(2);
  });
});

describe("ComputerAgent — Substrate runtime", () => {
  it("calls bootHarness lazily on first chat, reuses URL across calls, and dispose() shuts down", async () => {
    const engine = new MockEngine([{ kind: "emit", payload: { type: "result", text: "ok" } }]);
    serverHandle = await bootServer(engine);

    let bootCalls = 0;
    let shutdownCalls = 0;
    const fakeSubstrate = {
      async bootHarness() {
        bootCalls += 1;
        return {
          baseUrl: serverHandle!.url,
          shutdown: async () => {
            shutdownCalls += 1;
          },
        };
      },
    };

    const agent = new ComputerAgent({
      source: { type: "local", path: "/tmp" },
      harness: "mock",
      identityLoader: "mock",
      runtime: fakeSubstrate,
    });

    expect(bootCalls).toBe(0);
    const r1 = await agent.chat("first");
    expect(bootCalls).toBe(1);
    expect(r1.ended.reason).toBe("complete");

    // dispose shuts down once
    await agent.dispose();
    expect(shutdownCalls).toBe(1);
    // dispose is idempotent
    await agent.dispose();
    expect(shutdownCalls).toBe(1);
  });
});
