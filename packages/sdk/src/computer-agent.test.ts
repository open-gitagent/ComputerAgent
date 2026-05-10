import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHarnessServer } from "@computeragent/harness-server";
import { MockEngine, MockLoader } from "@computeragent/testing";
import { ComputerAgent } from "./computer-agent.js";

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
});
