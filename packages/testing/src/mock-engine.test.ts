import { describe, expect, it } from "vitest";
import { MockEngine } from "./mock-engine.js";
import type { EngineContext, PermissionRequest } from "@open-gitagent/protocol";

function makeCtx(overrides: Partial<EngineContext<unknown>> = {}): EngineContext<unknown> {
  const ctrl = new AbortController();
  return {
    sessionId: "sess_test",
    options: {},
    workdir: "/tmp/x",
    envs: {},
    userMessageQueue: (async function* () {})(),
    onPermissionRequest: async () => ({ behavior: "allow", updatedInput: {} }),
    abortSignal: ctrl.signal,
    ...overrides,
  };
}

describe("MockEngine", () => {
  it("yields scripted emit events in order", async () => {
    const engine = new MockEngine([
      { kind: "emit", payload: { type: "system" } },
      { kind: "emit", payload: { type: "assistant" } },
    ]);
    const out: unknown[] = [];
    for await (const ev of engine.startSession(makeCtx())) {
      out.push(ev);
    }
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ kind: "sdk_message", payload: { type: "system" } });
  });

  it("calls onPermissionRequest and asserts on the decision", async () => {
    const got: PermissionRequest[] = [];
    const engine = new MockEngine([
      { kind: "ask_permission", toolName: "Bash", expect: "allow" },
    ]);
    const ctx = makeCtx({
      onPermissionRequest: async (req) => {
        got.push(req);
        return { behavior: "allow", updatedInput: req.input };
      },
    });
    for await (const _ of engine.startSession(ctx)) { /* drain */ }
    expect(got).toHaveLength(1);
    expect(got[0]?.toolName).toBe("Bash");
  });

  it("stops on abort during wait_ms", async () => {
    const ctrl = new AbortController();
    const engine = new MockEngine([{ kind: "wait_ms", ms: 5000 }]);
    const ctx = makeCtx({ abortSignal: ctrl.signal });

    const drain = (async () => {
      try {
        for await (const _ of engine.startSession(ctx)) { /* nothing */ }
      } catch (e) {
        return (e as Error).message;
      }
      return "no-error";
    })();

    setTimeout(() => ctrl.abort(), 10);
    const result = await drain;
    expect(result).toBe("aborted");
  });
});
