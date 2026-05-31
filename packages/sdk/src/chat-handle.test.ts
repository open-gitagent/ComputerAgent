/**
 * Unit tests for `ChatHandle` — exercise the parts that are easy to get subtly
 * wrong with no live harness:
 *
 *   - Usage aggregation: tokens always SUM; cost respects `costSemantic`
 *     (cumulative → MAX, delta → SUM, mixed → prefer cumulative).
 *   - The dual interface: `for await` yields raw events; `await handle`
 *     resolves to a ChatResult. Both consume the same stream once.
 *   - Permission callback contract: `onPermissionRequest` is called with the
 *     exact args from the event, and the resolved decision is POSTed back to
 *     the harness. Default decision is "allow".
 *   - Lifecycle: `onComplete` fires after `ca_session_ended`; `drain()`
 *     throws when the stream closes without an end event; `result()` is
 *     memoized.
 *
 * Everything is mocked — no network, no harness — so the suite runs in <50ms.
 */
import { describe, it, expect, vi } from "vitest";
import type { HarnessEvent } from "@open-gitagent/protocol";
import { ChatHandle } from "./chat-handle.js";
import type { PermissionDecision } from "./types.js";

const SESS = "sess_test_01";
const HARNESS = "http://localhost:9999";

/** Tiny helper: turn a fixed list of events into an AsyncIterable<HarnessEvent>. */
async function* iter(events: HarnessEvent[]): AsyncIterable<HarnessEvent> {
  for (const ev of events) yield ev;
}

/** Build a ChatHandle wired to a deterministic event stream + a fetch mock. */
function makeHandle(
  events: HarnessEvent[],
  extra: {
    onPermissionRequest?: (
      callId: string,
      toolName: string,
      input: unknown,
      risk?: "low" | "medium" | "high" | "destructive",
    ) => Promise<PermissionDecision> | PermissionDecision;
    onComplete?: () => Promise<void> | void;
  } = {},
): { handle: ChatHandle; fetchImpl: ReturnType<typeof vi.fn> } {
  const fetchImpl = vi.fn(async () =>
    new Response("", { status: 200, headers: { "content-type": "application/json" } }),
  );
  const handle = new ChatHandle({
    sessionIdPromise: Promise.resolve(SESS),
    events: iter(events),
    harnessUrlPromise: Promise.resolve(HARNESS),
    fetchImpl: fetchImpl as unknown as typeof fetch,
    ...extra,
  });
  return { handle, fetchImpl };
}

const endedEvent = (): HarnessEvent =>
  ({ kind: "ca_session_ended", sessionId: SESS, reason: "complete" } as HarnessEvent);

describe("ChatHandle — usage aggregation", () => {
  it("sums input/output tokens across snapshots", async () => {
    const { handle } = makeHandle([
      { kind: "ca_usage_snapshot", sessionId: SESS, inputTokens: 100, outputTokens: 30 } as HarnessEvent,
      { kind: "ca_usage_snapshot", sessionId: SESS, inputTokens: 50, outputTokens: 12 } as HarnessEvent,
      endedEvent(),
    ]);
    const result = await handle;
    expect(result.usage.inputTokens).toBe(150);
    expect(result.usage.outputTokens).toBe(42);
  });

  it("sums cache creation + cache read tokens", async () => {
    const { handle } = makeHandle([
      { kind: "ca_usage_snapshot", sessionId: SESS, cacheCreationInputTokens: 200, cacheReadInputTokens: 800 } as HarnessEvent,
      { kind: "ca_usage_snapshot", sessionId: SESS, cacheCreationInputTokens: 50, cacheReadInputTokens: 100 } as HarnessEvent,
      endedEvent(),
    ]);
    const result = await handle;
    expect(result.usage.cacheCreationInputTokens).toBe(250);
    expect(result.usage.cacheReadInputTokens).toBe(900);
  });

  it("cost: cumulative semantic → takes the MAX across snapshots", async () => {
    // claude-agent-sdk emits a running cumulative total; we should latch onto
    // the largest value seen (typically the last one).
    const { handle } = makeHandle([
      { kind: "ca_usage_snapshot", sessionId: SESS, costUsd: 0.01, costSemantic: "cumulative" } as HarnessEvent,
      { kind: "ca_usage_snapshot", sessionId: SESS, costUsd: 0.04, costSemantic: "cumulative" } as HarnessEvent,
      { kind: "ca_usage_snapshot", sessionId: SESS, costUsd: 0.03, costSemantic: "cumulative" } as HarnessEvent,
      endedEvent(),
    ]);
    const result = await handle;
    expect(result.usage.costUsd).toBe(0.04);
  });

  it("cost: delta semantic → SUMs per-message values", async () => {
    // gitclaw emits per-message deltas; we should add them up.
    const { handle } = makeHandle([
      { kind: "ca_usage_snapshot", sessionId: SESS, costUsd: 0.01, costSemantic: "delta" } as HarnessEvent,
      { kind: "ca_usage_snapshot", sessionId: SESS, costUsd: 0.02, costSemantic: "delta" } as HarnessEvent,
      { kind: "ca_usage_snapshot", sessionId: SESS, costUsd: 0.005, costSemantic: "delta" } as HarnessEvent,
      endedEvent(),
    ]);
    const result = await handle;
    expect(result.usage.costUsd).toBeCloseTo(0.035, 5);
  });

  it("cost: undefined semantic is treated as cumulative (defensive)", async () => {
    const { handle } = makeHandle([
      { kind: "ca_usage_snapshot", sessionId: SESS, costUsd: 0.07 } as HarnessEvent,
      { kind: "ca_usage_snapshot", sessionId: SESS, costUsd: 0.04 } as HarnessEvent,
      endedEvent(),
    ]);
    const result = await handle;
    // MAX, not SUM
    expect(result.usage.costUsd).toBe(0.07);
  });

  it("cost: mixed cumulative + delta in one turn → prefer cumulative (no double-count)", async () => {
    // Defensive case — shouldn't happen in practice but the SDK has explicit
    // handling and a documented preference. Pin the behavior.
    const { handle } = makeHandle([
      { kind: "ca_usage_snapshot", sessionId: SESS, costUsd: 0.10, costSemantic: "cumulative" } as HarnessEvent,
      { kind: "ca_usage_snapshot", sessionId: SESS, costUsd: 0.02, costSemantic: "delta" } as HarnessEvent,
      endedEvent(),
    ]);
    const result = await handle;
    expect(result.usage.costUsd).toBe(0.10);
  });

  it("no cost snapshots → costUsd is undefined", async () => {
    const { handle } = makeHandle([
      { kind: "ca_usage_snapshot", sessionId: SESS, inputTokens: 100, outputTokens: 30 } as HarnessEvent,
      endedEvent(),
    ]);
    const result = await handle;
    expect(result.usage.costUsd).toBeUndefined();
    expect(result.usage.inputTokens).toBe(100);
  });

  it("getUsage() returns the same rollup mid-stream and after drain", async () => {
    const { handle } = makeHandle([
      { kind: "ca_usage_snapshot", sessionId: SESS, inputTokens: 10, costUsd: 0.01, costSemantic: "cumulative" } as HarnessEvent,
      { kind: "sdk_message", sessionId: SESS, payload: {} } as HarnessEvent,
      { kind: "ca_usage_snapshot", sessionId: SESS, inputTokens: 5, costUsd: 0.05, costSemantic: "cumulative" } as HarnessEvent,
      endedEvent(),
    ]);
    let midSnapshotInput = 0;
    for await (const ev of handle) {
      if (ev.kind === "sdk_message") {
        midSnapshotInput = handle.getUsage().inputTokens;
      }
    }
    // After the first snapshot, before the second.
    expect(midSnapshotInput).toBe(10);
    // After drain — second snapshot has been folded in.
    expect(handle.getUsage().inputTokens).toBe(15);
    expect(handle.getUsage().costUsd).toBe(0.05);
  });
});

describe("ChatHandle — dual iteration interface", () => {
  it("`for await` yields every event in order", async () => {
    const { handle } = makeHandle([
      { kind: "sdk_message", sessionId: SESS, payload: "a" } as HarnessEvent,
      { kind: "sdk_message", sessionId: SESS, payload: "b" } as HarnessEvent,
      endedEvent(),
    ]);
    const kinds: string[] = [];
    for await (const ev of handle) kinds.push(ev.kind);
    expect(kinds).toEqual(["sdk_message", "sdk_message", "ca_session_ended"]);
  });

  it("`await handle` drains to a ChatResult", async () => {
    const { handle } = makeHandle([
      { kind: "sdk_message", sessionId: SESS, payload: { role: "assistant" } } as HarnessEvent,
      endedEvent(),
    ]);
    const result = await handle;
    expect(result.sessionId).toBe(SESS);
    expect(result.messages).toHaveLength(1);
    expect(result.ended.reason).toBe("complete");
  });

  it("result() is memoized — calling twice doesn't re-drain", async () => {
    // Build a generator that only yields once; if drain() re-iterated, the
    // second call would hang or throw. Memoization should give us the
    // cached promise on call #2.
    let yields = 0;
    async function* once(): AsyncIterable<HarnessEvent> {
      if (yields > 0) throw new Error("re-iteration would dead-lock");
      yields++;
      yield endedEvent();
    }
    const handle = new ChatHandle({
      sessionIdPromise: Promise.resolve(SESS),
      events: once(),
      harnessUrlPromise: Promise.resolve(HARNESS),
      fetchImpl: (async () => new Response("", { status: 200 })) as unknown as typeof fetch,
    });
    const a = await handle.result();
    const b = await handle.result();
    expect(a).toBe(b);
  });

  it("drain() throws if the stream closes without ca_session_ended", async () => {
    const { handle } = makeHandle([
      { kind: "sdk_message", sessionId: SESS, payload: "stranded" } as HarnessEvent,
      // no ca_session_ended
    ]);
    await expect(handle.result()).rejects.toThrow(/ca_session_ended/);
  });
});

describe("ChatHandle — permission callback", () => {
  it("calls onPermissionRequest with event args + POSTs the decision", async () => {
    const onPermissionRequest = vi.fn(async () => ({ decision: "allow" as const }));
    const { handle, fetchImpl } = makeHandle(
      [
        {
          kind: "ca_permission_request",
          sessionId: SESS,
          callId: "call_42",
          toolName: "Bash",
          input: { command: "ls" },
          risk: "low",
        } as HarnessEvent,
        endedEvent(),
      ],
      { onPermissionRequest },
    );

    await handle.result();

    // Hook fired exactly once with the exact event payload (minus discriminator).
    expect(onPermissionRequest).toHaveBeenCalledOnce();
    expect(onPermissionRequest).toHaveBeenCalledWith(
      "call_42",
      "Bash",
      { command: "ls" },
      "low",
    );

    // Decision was POSTed back to the harness at the right URL shape.
    expect(fetchImpl).toHaveBeenCalledWith(
      `${HARNESS}/v1/sessions/${SESS}/permission/call_42`,
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "Content-Type": "application/json" }),
      }),
    );
  });

  it("default decision is `allow` when no onPermissionRequest is provided", async () => {
    const { handle, fetchImpl } = makeHandle([
      {
        kind: "ca_permission_request",
        sessionId: SESS,
        callId: "call_1",
        toolName: "Read",
        input: { path: "/etc/hostname" },
      } as HarnessEvent,
      endedEvent(),
    ]);
    await handle.result();

    // The first call should be the permission POST. Body says allow.
    const firstCall = fetchImpl.mock.calls[0];
    expect(firstCall[0]).toBe(`${HARNESS}/v1/sessions/${SESS}/permission/call_1`);
    const body = JSON.parse(firstCall[1].body);
    expect(body.decision).toBe("allow");
  });

  it("honors a custom deny decision", async () => {
    const onPermissionRequest = vi.fn(async () => ({
      decision: "deny" as const,
      reason: "test refusal",
    }));
    const { handle, fetchImpl } = makeHandle(
      [
        {
          kind: "ca_permission_request",
          sessionId: SESS,
          callId: "call_9",
          toolName: "Bash",
          input: { command: "rm -rf /" },
          risk: "destructive",
        } as HarnessEvent,
        endedEvent(),
      ],
      { onPermissionRequest },
    );

    await handle.result();

    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.decision).toBe("deny");
    expect(body.reason).toBe("test refusal");
  });
});

describe("ChatHandle — lifecycle", () => {
  it("fires onComplete after ca_session_ended (once)", async () => {
    const onComplete = vi.fn();
    const { handle } = makeHandle(
      [
        { kind: "sdk_message", sessionId: SESS, payload: "x" } as HarnessEvent,
        endedEvent(),
      ],
      { onComplete },
    );
    await handle.result();
    expect(onComplete).toHaveBeenCalledOnce();
  });

  it("does NOT fire onComplete if stream never ends", async () => {
    const onComplete = vi.fn();
    const { handle } = makeHandle(
      [{ kind: "sdk_message", sessionId: SESS, payload: "x" } as HarnessEvent],
      { onComplete },
    );
    // Drain throws (no end), but we still verify the hook didn't fire.
    await expect(handle.result()).rejects.toThrow();
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("collects every sdk_message payload into result.messages, in order", async () => {
    const payloads = [
      { type: "assistant", text: "hi" },
      { type: "tool_use", name: "Bash" },
      { type: "assistant", text: "done" },
    ];
    const { handle } = makeHandle([
      ...payloads.map((p) => ({ kind: "sdk_message", sessionId: SESS, payload: p }) as HarnessEvent),
      endedEvent(),
    ]);
    const result = await handle.result();
    expect(result.messages).toEqual(payloads);
  });

  it("cancel() POSTs /cancel for the right session", async () => {
    const { handle, fetchImpl } = makeHandle([endedEvent()]);
    await handle.cancel();
    expect(fetchImpl).toHaveBeenCalledWith(
      `${HARNESS}/v1/sessions/${SESS}/cancel`,
      expect.objectContaining({ method: "POST" }),
    );
  });
});
