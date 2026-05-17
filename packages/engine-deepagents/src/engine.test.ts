import { describe, expect, it } from "vitest";
import { DeepAgentsEngine } from "./engine.js";

describe("DeepAgentsEngine", () => {
  it("declares the expected capability set", () => {
    const e = new DeepAgentsEngine();
    expect(e.name).toBe("deepagents");
    expect(e.capabilities).toEqual({
      streamingInput: true,
      partialMessages: false,
      permissionCallback: false,
      sessions: true,
      budget: false,
    });
  });

  it("startSession returns an AsyncIterable (lazy-imports deepagents)", () => {
    const e = new DeepAgentsEngine();
    const ctrl = new AbortController();
    ctrl.abort();
    const stream = e.startSession({
      sessionId: "sess_test",
      options: {},
      workdir: "/tmp",
      envs: { ANTHROPIC_API_KEY: "test-key" },
      userMessageQueue: (async function* () {})(),
      onPermissionRequest: async () => ({ behavior: "deny", message: "n/a" }),
      abortSignal: ctrl.signal,
    });
    expect(typeof (stream as AsyncIterable<unknown>)[Symbol.asyncIterator]).toBe("function");
  });

  it("throws cleanly when ANTHROPIC_API_KEY is missing", async () => {
    const e = new DeepAgentsEngine();
    const ctrl = new AbortController();
    const stream = e.startSession({
      sessionId: "sess_t",
      options: {},
      workdir: "/tmp",
      envs: {},
      userMessageQueue: (async function* () {
        yield { role: "user" as const, content: "hi" };
      })(),
      onPermissionRequest: async () => ({ behavior: "deny", message: "n/a" }),
      abortSignal: ctrl.signal,
    });
    await expect(async () => {
      for await (const _ of stream) { /* drain */ }
    }).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });
});
