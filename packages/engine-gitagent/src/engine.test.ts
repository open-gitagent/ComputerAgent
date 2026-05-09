import { describe, expect, it } from "vitest";
import { GitAgentEngine } from "./engine.js";

describe("GitAgentEngine", () => {
  it("declares the expected capability set", () => {
    const e = new GitAgentEngine();
    expect(e.name).toBe("gitagent");
    expect(e.capabilities).toEqual({
      streamingInput: true,
      partialMessages: true,
      permissionCallback: true,
      sessions: true,
      budget: false,
    });
  });

  it("startSession returns an AsyncIterable (no real LLM call here)", () => {
    const e = new GitAgentEngine();
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
});
