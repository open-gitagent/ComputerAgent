import type { EngineDriver, HarnessEvent } from "@computeragent/protocol";
import type { Session } from "../session.js";

/**
 * Drives the engine for a session and yields HarnessEvents in order.
 *
 * Emits exactly one `ca_session_started` first and exactly one `ca_session_ended` last.
 * Forwards engine `sdk_message` events verbatim. Maps engine `ca_usage_snapshot` events
 * to wire `ca_usage_snapshot` events.
 *
 * Errors and aborts collapse into the terminal `ca_session_ended` event — never throws past
 * its own iteration boundary.
 */
export async function* runSession(
  engine: EngineDriver,
  session: Session,
): AsyncIterable<HarnessEvent> {
  yield {
    kind: "ca_session_started",
    sessionId: session.sessionId,
    engine: session.engineName,
    identity: session.identity,
    capabilities: session.capabilities,
  };

  session.status = "running";

  try {
    const stream = engine.startSession({
      sessionId: session.sessionId,
      options: session.engineOptions,
      workdir: session.workdir,
      envs: session.envs,
      userMessageQueue: session.userMessages(),
      onPermissionRequest: (req) => session.awaitPermission(req),
      abortSignal: session.abortController.signal,
    });

    for await (const event of stream) {
      if (session.abortController.signal.aborted) break;
      if (event.kind === "sdk_message") {
        yield { kind: "sdk_message", sessionId: session.sessionId, payload: event.payload };
      } else if (event.kind === "ca_usage_snapshot") {
        yield {
          kind: "ca_usage_snapshot",
          sessionId: session.sessionId,
          ...(event.inputTokens !== undefined ? { inputTokens: event.inputTokens } : {}),
          ...(event.outputTokens !== undefined ? { outputTokens: event.outputTokens } : {}),
          ...(event.costUsd !== undefined ? { costUsd: event.costUsd } : {}),
        };
      }
    }

    const wasCancelled = session.abortController.signal.aborted;
    if (!wasCancelled) session.status = "completed";
    yield {
      kind: "ca_session_ended",
      sessionId: session.sessionId,
      reason: wasCancelled ? "cancelled" : "complete",
    };
  } catch (err) {
    session.status = "errored";
    yield {
      kind: "ca_session_ended",
      sessionId: session.sessionId,
      reason: "error",
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }
}
