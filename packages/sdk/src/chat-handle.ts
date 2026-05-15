import type { HarnessEvent } from "@computeragent/protocol";
import type { ChatResult, PermissionDecision, UsageRollup } from "./types.js";
import { decisionToBody } from "./types.js";

interface ChatHandleDeps {
  /** Resolves to the real sessionId once `POST /v1/sessions` returns. */
  readonly sessionIdPromise: Promise<string>;
  readonly events: AsyncIterable<HarnessEvent>;
  /** Harness URL — async because substrates may boot lazily. */
  readonly harnessUrlPromise: Promise<string>;
  readonly fetchImpl: typeof fetch;
  /** Hook fired by the handle for each ca_permission_request, before it auto-decides. */
  readonly onPermissionRequest?: (callId: string, toolName: string, input: unknown) =>
    Promise<PermissionDecision> | PermissionDecision;
  /** Optional cleanup (e.g. delete the session) when the handle is fully consumed. */
  readonly onComplete?: () => Promise<void> | void;
}

/**
 * The return value of `agent.chat(input)`.
 *
 * Dual interface, by design:
 *   - `for await (const ev of handle)` — iterate raw HarnessEvents
 *   - `await handle` (or `await handle.result()`) — drain to a ChatResult
 *
 * Inspired by Anthropic's `client.messages.stream(...)` shape.
 */
export class ChatHandle implements AsyncIterable<HarnessEvent>, PromiseLike<ChatResult> {
  private resultPromise: Promise<ChatResult> | undefined;
  private readonly collectedMessages: unknown[] = [];
  /** Running aggregate of usage snapshots seen during the turn. */
  private readonly usage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    cumulativeCostUsd: undefined as number | undefined,    // for "cumulative" semantic — track max
    deltaCostUsdSum: 0,                                    // for "delta" semantic — sum
    sawCost: false,
    sawDelta: false,
  };

  constructor(private readonly deps: ChatHandleDeps) {}

  /** Resolves to the session id (after `POST /v1/sessions` returns). */
  sessionId(): Promise<string> {
    return this.deps.sessionIdPromise;
  }

  /**
   * Snapshot of the usage aggregator at this moment. Callable during or
   * after iteration — `for await (const ev of handle) { ... handle.getUsage() ... }`
   * works, as does reading it after the loop exits.
   *
   * Equivalent to `result.usage` after `await handle`, but doesn't require
   * a second drain — useful when the caller is streaming events themselves
   * and just wants the rollup at the end.
   */
  getUsage(): UsageRollup {
    return this.finalizeUsage();
  }

  /** Iterate raw events. Yields once per HarnessEvent the server emits. */
  async *[Symbol.asyncIterator](): AsyncIterator<HarnessEvent> {
    for await (const ev of this.deps.events) {
      if (ev.kind === "sdk_message") this.collectedMessages.push(ev.payload);
      if (ev.kind === "ca_permission_request") {
        await this.handlePermission(ev.callId, ev.toolName, ev.input);
      }
      if (ev.kind === "ca_usage_snapshot") this.absorbUsage(ev);
      yield ev;
      if (ev.kind === "ca_session_ended") {
        if (this.deps.onComplete) await this.deps.onComplete();
        return;
      }
    }
  }

  /**
   * Fold a usage snapshot into the running aggregate. Tokens always SUM.
   * Cost depends on the engine's `costSemantic`:
   *   - "cumulative" (Claude SDK): keep the MAX value seen
   *   - "delta" (gitclaw):          SUM the per-message values
   *   - undefined:                  treat as cumulative for safety
   *
   * If a single turn somehow mixes both semantics (e.g. two engines in a
   * chain — not currently possible but defensive), we prefer the cumulative
   * value to avoid double-counting.
   */
  private absorbUsage(ev: Extract<HarnessEvent, { kind: "ca_usage_snapshot" }>): void {
    if (ev.inputTokens !== undefined) this.usage.inputTokens += ev.inputTokens;
    if (ev.outputTokens !== undefined) this.usage.outputTokens += ev.outputTokens;
    if (ev.cacheCreationInputTokens !== undefined) {
      this.usage.cacheCreationInputTokens += ev.cacheCreationInputTokens;
    }
    if (ev.cacheReadInputTokens !== undefined) {
      this.usage.cacheReadInputTokens += ev.cacheReadInputTokens;
    }
    if (ev.costUsd !== undefined) {
      this.usage.sawCost = true;
      if (ev.costSemantic === "delta") {
        this.usage.deltaCostUsdSum += ev.costUsd;
        this.usage.sawDelta = true;
      } else {
        // "cumulative" or undefined — track the max.
        if (this.usage.cumulativeCostUsd === undefined || ev.costUsd > this.usage.cumulativeCostUsd) {
          this.usage.cumulativeCostUsd = ev.costUsd;
        }
      }
    }
  }

  private finalizeUsage(): UsageRollup {
    let costUsd: number | undefined;
    if (this.usage.sawCost) {
      // Prefer cumulative when both seen — see absorbUsage doc.
      if (this.usage.cumulativeCostUsd !== undefined) {
        costUsd = this.usage.cumulativeCostUsd;
      } else if (this.usage.sawDelta) {
        costUsd = this.usage.deltaCostUsdSum;
      }
    }
    return {
      inputTokens: this.usage.inputTokens,
      outputTokens: this.usage.outputTokens,
      cacheCreationInputTokens: this.usage.cacheCreationInputTokens,
      cacheReadInputTokens: this.usage.cacheReadInputTokens,
      costUsd,
    };
  }

  /** Drain to completion and return the final result. Memoized. */
  result(): Promise<ChatResult> {
    if (!this.resultPromise) this.resultPromise = this.drain();
    return this.resultPromise;
  }

  /** PromiseLike: `await handle` works the same as `await handle.result()`. */
  then<TResult1 = ChatResult, TResult2 = never>(
    onfulfilled?: ((value: ChatResult) => TResult1 | PromiseLike<TResult1>) | null | undefined,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null | undefined,
  ): PromiseLike<TResult1 | TResult2> {
    return this.result().then(onfulfilled, onrejected);
  }

  /** Cancel the in-flight session via the harness server. */
  async cancel(): Promise<void> {
    const [sid, harnessUrl] = await Promise.all([this.deps.sessionIdPromise, this.deps.harnessUrlPromise]);
    await this.deps.fetchImpl(`${harnessUrl}/v1/sessions/${sid}/cancel`, {
      method: "POST",
    });
  }

  /** Manually answer a permission request — mainly for callers iterating events directly. */
  async respondToPermission(callId: string, decision: PermissionDecision): Promise<void> {
    const [sid, harnessUrl] = await Promise.all([this.deps.sessionIdPromise, this.deps.harnessUrlPromise]);
    await postPermission(this.deps.fetchImpl, harnessUrl, sid, callId, decision);
  }

  private async drain(): Promise<ChatResult> {
    let ended: Extract<HarnessEvent, { kind: "ca_session_ended" }> | undefined;
    for await (const ev of this) {
      if (ev.kind === "ca_session_ended") ended = ev;
    }
    if (!ended) {
      throw new Error("ChatHandle: stream closed without ca_session_ended");
    }
    return {
      sessionId: await this.deps.sessionIdPromise,
      messages: this.collectedMessages,
      ended,
      usage: this.finalizeUsage(),
    };
  }

  private async handlePermission(callId: string, toolName: string, input: unknown): Promise<void> {
    const decision = this.deps.onPermissionRequest
      ? await this.deps.onPermissionRequest(callId, toolName, input)
      : { decision: "allow" as const };
    const [sid, harnessUrl] = await Promise.all([this.deps.sessionIdPromise, this.deps.harnessUrlPromise]);
    await postPermission(this.deps.fetchImpl, harnessUrl, sid, callId, decision);
  }
}

async function postPermission(
  fetchImpl: typeof fetch,
  harnessUrl: string,
  sessionId: string,
  callId: string,
  decision: PermissionDecision,
): Promise<void> {
  await fetchImpl(`${harnessUrl}/v1/sessions/${sessionId}/permission/${callId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(decisionToBody(decision)),
  });
}
