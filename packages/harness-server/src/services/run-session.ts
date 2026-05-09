import type { EngineDriver, HarnessEvent } from "@computeragent/protocol";
import type { Session } from "../session.js";
import { EventChannel } from "../event-channel.js";

/**
 * Drives the engine for a session and yields HarnessEvents in order.
 *
 * Emits exactly one `ca_session_started` first and exactly one `ca_session_ended` last.
 * Forwards engine `sdk_message` events verbatim. When the engine calls
 * `onPermissionRequest`, a `ca_permission_request` event is pushed to the SSE
 * stream BEFORE the permission promise is awaited — so clients see the callId
 * and can POST a decision.
 *
 * Errors and aborts collapse into the terminal `ca_session_ended` event — never
 * throws past its own iteration boundary.
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

  const channel = new EventChannel<HarnessEvent>();

  // Drain the engine into the channel in the background.
  const drain = (async () => {
    try {
      const stream = engine.startSession({
        sessionId: session.sessionId,
        options: session.engineOptions,
        workdir: session.workdir,
        envs: session.envs,
        userMessageQueue: session.userMessages(),
        onPermissionRequest: async (req) => {
          channel.push({
            kind: "ca_permission_request",
            sessionId: session.sessionId,
            callId: req.callId,
            toolName: req.toolName,
            input: req.input,
          });
          return session.awaitPermission(req);
        },
        abortSignal: session.abortController.signal,
      });

      for await (const event of stream) {
        if (session.abortController.signal.aborted) break;
        if (event.kind === "sdk_message") {
          channel.push({
            kind: "sdk_message",
            sessionId: session.sessionId,
            payload: event.payload,
          });
        } else if (event.kind === "ca_usage_snapshot") {
          channel.push({
            kind: "ca_usage_snapshot",
            sessionId: session.sessionId,
            ...(event.inputTokens !== undefined ? { inputTokens: event.inputTokens } : {}),
            ...(event.outputTokens !== undefined ? { outputTokens: event.outputTokens } : {}),
            ...(event.costUsd !== undefined ? { costUsd: event.costUsd } : {}),
          });
        }
      }

      const wasCancelled = session.abortController.signal.aborted;
      if (!wasCancelled) session.status = "completed";
      channel.push({
        kind: "ca_session_ended",
        sessionId: session.sessionId,
        reason: wasCancelled ? "cancelled" : "complete",
      });
    } catch (err) {
      if (session.abortController.signal.aborted) {
        session.status = "cancelled";
        channel.push({
          kind: "ca_session_ended",
          sessionId: session.sessionId,
          reason: "cancelled",
        });
      } else {
        session.status = "errored";
        channel.push({
          kind: "ca_session_ended",
          sessionId: session.sessionId,
          reason: "error",
          errorMessage: err instanceof Error ? err.message : String(err),
        });
      }
    } finally {
      channel.close();
    }
  })();

  for await (const ev of channel) {
    yield ev;
    if (ev.kind === "ca_session_ended") break;
  }
  await drain;
}
