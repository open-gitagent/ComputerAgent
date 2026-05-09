import type {
  EngineCapabilities,
  EngineContext,
  EngineDriver,
  EngineEvent,
  PermissionRequest,
} from "@computeragent/protocol";
import type { PermissionResult } from "@computeragent/protocol";

/**
 * A scripted "step" the MockEngine performs. Tests build a sequence of these
 * to exercise specific harness-server behaviors deterministically.
 */
export type MockStep =
  | { kind: "emit"; payload: unknown }
  | { kind: "ask_permission"; toolName: string; input?: unknown; expect: PermissionResult["behavior"] }
  | { kind: "wait_for_user_message" }
  | { kind: "wait_ms"; ms: number };

const DEFAULT_CAPABILITIES: EngineCapabilities = {
  streamingInput: true,
  partialMessages: true,
  permissionCallback: true,
  sessions: true,
  budget: true,
};

/**
 * Deterministic engine for harness-server tests.
 * Pass a script of steps; the engine runs them in order, then completes.
 *
 * - `emit`: yield an `sdk_message` with the given payload.
 * - `ask_permission`: call `ctx.onPermissionRequest`; assert the returned decision matches `expect`.
 * - `wait_for_user_message`: pull one user message off the queue (proves messages flow in).
 * - `wait_ms`: sleep (used for cancel/abort tests).
 */
export class MockEngine implements EngineDriver<unknown> {
  readonly name = "mock";
  readonly capabilities: EngineCapabilities;
  readonly received: { permissions: PermissionRequest[]; userMessages: unknown[] } = {
    permissions: [],
    userMessages: [],
  };

  constructor(
    private readonly script: readonly MockStep[],
    capabilities: Partial<EngineCapabilities> = {},
  ) {
    this.capabilities = { ...DEFAULT_CAPABILITIES, ...capabilities };
  }

  async *startSession(ctx: EngineContext<unknown>): AsyncIterable<EngineEvent> {
    const userIter = ctx.userMessageQueue[Symbol.asyncIterator]();

    for (const step of this.script) {
      if (ctx.abortSignal.aborted) return;

      if (step.kind === "emit") {
        yield { kind: "sdk_message", payload: step.payload };
      } else if (step.kind === "ask_permission") {
        const callId = `mock-call-${this.received.permissions.length + 1}`;
        const req: PermissionRequest = {
          callId,
          toolName: step.toolName,
          input: step.input ?? {},
        };
        this.received.permissions.push(req);
        const result = await ctx.onPermissionRequest(req);
        if (result.behavior !== step.expect) {
          throw new Error(
            `MockEngine: expected permission ${step.expect}, got ${result.behavior}`,
          );
        }
      } else if (step.kind === "wait_for_user_message") {
        const next = await userIter.next();
        if (next.done) return;
        this.received.userMessages.push(next.value);
      } else if (step.kind === "wait_ms") {
        await sleep(step.ms, ctx.abortSignal);
      }
    }
  }
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error("aborted"));
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new Error("aborted"));
    }, { once: true });
  });
}
