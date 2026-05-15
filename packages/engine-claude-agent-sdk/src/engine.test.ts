import { describe, expect, it, vi } from "vitest";
import { ClaudeAgentEngine } from "./engine.js";

describe("ClaudeAgentEngine", () => {
  it("declares the expected capability set", () => {
    const e = new ClaudeAgentEngine();
    expect(e.name).toBe("claude-agent-sdk");
    expect(e.capabilities).toEqual({
      streamingInput: true,
      partialMessages: true,
      permissionCallback: true,
      sessions: true,
      budget: true,
    });
  });

  it("startSession returns an AsyncIterable (no real LLM call here)", () => {
    const e = new ClaudeAgentEngine();
    const ctrl = new AbortController();
    ctrl.abort();
    const stream = e.startSession({
      sessionId: "sess_test",
      options: {},
      workdir: "/tmp",
      envs: {},
      userMessageQueue: (async function* () {})(),
      onPermissionRequest: async () => ({ behavior: "deny", message: "n/a" }),
      abortSignal: ctrl.signal,
    });
    expect(typeof (stream as AsyncIterable<unknown>)[Symbol.asyncIterator]).toBe("function");
  });

  it("emits ca_usage_snapshot after each SDKResultMessage (issue #5)", async () => {
    // Mock @anthropic-ai/claude-agent-sdk's `query()` to yield a fixed
    // result-typed message carrying real-world usage shape.
    vi.doMock("@anthropic-ai/claude-agent-sdk", async () => ({
      query: async function* mockQuery() {
        yield { type: "assistant", message: { content: [{ type: "text", text: "hi" }] } };
        yield {
          type: "result",
          subtype: "success",
          duration_ms: 1234,
          num_turns: 1,
          result: "hello",
          total_cost_usd: 0.0301,
          usage: {
            input_tokens: 1000,
            output_tokens: 250,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 100,
          },
        };
      },
    }));

    vi.resetModules();
    const { ClaudeAgentEngine: PatchedEngine } = await import("./engine.js");

    const ctrl = new AbortController();
    const e = new PatchedEngine();
    const events: unknown[] = [];
    for await (const ev of e.startSession({
      sessionId: "sess_t",
      options: {},
      workdir: "/tmp",
      envs: {},
      userMessageQueue: (async function* () { yield { role: "user" as const, content: "hi" }; })(),
      onPermissionRequest: async () => ({ behavior: "deny", message: "n/a" }),
      abortSignal: ctrl.signal,
    })) {
      events.push(ev);
    }

    const usage = events.find((e) => (e as { kind?: string }).kind === "ca_usage_snapshot") as {
      kind: "ca_usage_snapshot";
      inputTokens?: number;
      outputTokens?: number;
      cacheReadInputTokens?: number;
      costUsd?: number;
      costSemantic?: "cumulative" | "delta";
    } | undefined;

    expect(usage).toBeDefined();
    expect(usage!.inputTokens).toBe(1000);
    expect(usage!.outputTokens).toBe(250);
    expect(usage!.cacheReadInputTokens).toBe(100);
    expect(usage!.costUsd).toBeCloseTo(0.0301, 6);
    expect(usage!.costSemantic).toBe("cumulative");

    vi.doUnmock("@anthropic-ai/claude-agent-sdk");
  });
});
