import { describe, expect, it, vi } from "vitest";
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

  it("multi-turn: each user message in the queue triggers a fresh query() with growing systemPromptSuffix (issue #4)", async () => {
    // Mock gitclaw's `query()` so we can observe what the engine calls it with
    // per turn. Each query() call records its options and yields exactly one
    // assistant message synthesized from the prompt it received.
    const queryCalls: { systemPromptSuffix: string | undefined; promptText: string }[] = [];

    vi.doMock("gitclaw", async () => ({
      // re-export the real types but stub `query`
      query: async function* mockQuery(options: { prompt: AsyncIterable<{ content: string }>; systemPromptSuffix?: string }) {
        let promptText = "";
        for await (const m of options.prompt) {
          promptText = m.content;
          break;
        }
        queryCalls.push({ systemPromptSuffix: options.systemPromptSuffix, promptText });
        yield { type: "assistant", content: `echo-${promptText}` };
      },
    }));

    // Re-import the engine module against the mocked gitclaw so the stubbed
    // query() is the one the engine sees. The static import at the top of
    // this file already loaded the real one for the previous tests, so we
    // bypass it via a dynamic import + vi.resetModules.
    vi.resetModules();
    const { GitAgentEngine: PatchedEngine } = await import("./engine.js");

    const e = new PatchedEngine();
    const ctrl = new AbortController();

    // Feed two user messages through the queue, one at a time.
    let resolveSecond: ((v: { type: "user"; content: string }) => void) | undefined;
    const second = new Promise<{ type: "user"; content: string }>((r) => { resolveSecond = r; });
    let endQueue = false;
    const userIter: AsyncIterable<{ role: "user"; content: string }> = {
      [Symbol.asyncIterator]: () => {
        let i = 0;
        return {
          async next() {
            if (i === 0) {
              i++;
              return { value: { role: "user" as const, content: "remember 42" }, done: false };
            }
            if (i === 1) {
              i++;
              const m = await second;
              return { value: { role: "user" as const, content: m.content }, done: false };
            }
            // Wait until parent signals end via endQueue flag — simulate /end-input.
            while (!endQueue) await new Promise((r) => setTimeout(r, 5));
            return { value: undefined, done: true };
          },
        };
      },
    };

    const stream = e.startSession({
      sessionId: "sess_mt",
      options: {},
      workdir: "/tmp",
      envs: {},
      userMessageQueue: userIter,
      onPermissionRequest: async () => ({ behavior: "deny", message: "n/a" }),
      abortSignal: ctrl.signal,
    });

    const yielded: unknown[] = [];
    const it = (stream as AsyncIterable<unknown>)[Symbol.asyncIterator]();

    // Pull turn 1's response
    const t1 = await it.next();
    yielded.push((t1.value as { payload: unknown }).payload);

    // Push the second user message + signal end of queue
    resolveSecond!({ type: "user", content: "what was the number" });
    endQueue = true;

    // Drain remaining
    while (true) {
      const r = await it.next();
      if (r.done) break;
      yielded.push((r.value as { payload: unknown }).payload);
    }

    // Two query() calls fired, one per user message
    expect(queryCalls).toHaveLength(2);

    // Turn 1: no prior context in the suffix
    expect(queryCalls[0]!.systemPromptSuffix).toBeUndefined();
    expect(queryCalls[0]!.promptText).toBe("remember 42");

    // Turn 2: prior context contains turn 1's user + assistant
    expect(queryCalls[1]!.systemPromptSuffix).toBeDefined();
    expect(queryCalls[1]!.systemPromptSuffix).toContain("user: remember 42");
    expect(queryCalls[1]!.systemPromptSuffix).toContain("assistant: echo-remember 42");
    expect(queryCalls[1]!.promptText).toBe("what was the number");

    // Two distinct assistant responses landed in the event stream
    expect(yielded).toEqual([
      { type: "assistant", content: "echo-remember 42" },
      { type: "assistant", content: "echo-what was the number" },
    ]);

    vi.doUnmock("gitclaw");
  });
});
