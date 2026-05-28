import type { EngineDriver, HarnessEvent, Logger, PermissionResult } from "@computeragent/protocol";
import { nopLogger } from "@computeragent/protocol";
import type { Session } from "../session.js";
import { EventChannel } from "../event-channel.js";

/**
 * Drives the engine for a session and pushes every emitted event into the
 * session's replay buffer. Closes the buffer when the engine terminates
 * (cleanly, cancelled, or errored).
 *
 * Engine drive is per-session, not per-connection. Multiple SSE consumers can
 * iterate `session.events` concurrently or sequentially; all see the same
 * monotonic id sequence. Resolves when the engine finishes.
 *
 * Emits exactly one `ca_session_started` first and exactly one `ca_session_ended`
 * last. Forwards engine `sdk_message` events verbatim. When the engine calls
 * `onPermissionRequest`, a `ca_permission_request` event is pushed BEFORE the
 * permission promise is awaited — so clients see the callId and can POST a
 * decision.
 *
 * Errors and aborts collapse into the terminal `ca_session_ended` event. Never
 * throws past its own boundary.
 */
export async function runSession(
  engine: EngineDriver,
  session: Session,
  logger: Logger = nopLogger,
): Promise<void> {
  const push = (ev: HarnessEvent): void => {
    session.emit(ev);
  };

  push({
    kind: "ca_session_started",
    sessionId: session.sessionId,
    engine: session.engineName,
    identity: session.identity,
    capabilities: session.capabilities,
  });

  const startedAt = Date.now();
  logger.info("session.start", {
    sessionId: session.sessionId,
    engine: session.engineName,
    identity: session.identity.name,
  });

  session.status = "running";

  const channel = new EventChannel<HarnessEvent>();

  const drain = (async () => {
    try {
      const stream = engine.startSession({
        sessionId: session.sessionId,
        options: session.engineOptions,
        workdir: session.workdir,
        envs: session.envs,
        userMessageQueue: session.userMessages(),
        onPermissionRequest: async (req) => {
          logger.info("session.permission_request", {
            sessionId: session.sessionId,
            callId: req.callId,
            toolName: req.toolName,
            risk: req.risk,
          });
          // Policy gate — if bound, consult before SSE round-trip. Deny short-circuits
          // with a behavior:"deny" PermissionResult; allow short-circuits with allow
          // (skip the SSE event entirely, no client mediation needed).
          if (session.policyDecider) {
            try {
              const decision = await session.policyDecider.evaluate({
                agentName: session.identity.name,
                sessionId: session.sessionId,
                toolName: req.toolName,
                toolArgs: (req.input as Record<string, unknown>) ?? {},
                principalId: session.identity.name,
              });
              logger.info("session.policy_decision", {
                sessionId: session.sessionId,
                callId: req.callId,
                toolName: req.toolName,
                allowed: decision.allowed,
                deniedBy: decision.deniedBy,
              });
              if (!decision.allowed) {
                return {
                  behavior: "deny",
                  message: decision.reason ?? `policy denied (${decision.deniedBy ?? "policy"})`,
                  interrupt: true,
                } as PermissionResult;
              }
              return { behavior: "allow", updatedInput: (req.input as Record<string, unknown>) ?? {} } as PermissionResult;
            } catch (err) {
              logger.warn("session.policy_error", { sessionId: session.sessionId, error: (err as Error).message });
              return {
                behavior: "deny",
                message: `policy decider error: ${(err as Error).message}`,
                interrupt: true,
              } as PermissionResult;
            }
          }
          channel.push({
            kind: "ca_permission_request",
            sessionId: session.sessionId,
            callId: req.callId,
            toolName: req.toolName,
            input: req.input,
            ...(req.risk !== undefined ? { risk: req.risk } : {}),
          });
          return session.awaitPermission(req);
        },
        abortSignal: session.abortController.signal,
        ...(session.sessionStore ? { sessionStore: session.sessionStore } : {}),
        logger,
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
            ...(event.cacheCreationInputTokens !== undefined
              ? { cacheCreationInputTokens: event.cacheCreationInputTokens }
              : {}),
            ...(event.cacheReadInputTokens !== undefined
              ? { cacheReadInputTokens: event.cacheReadInputTokens }
              : {}),
            ...(event.costUsd !== undefined ? { costUsd: event.costUsd } : {}),
            ...(event.costSemantic !== undefined ? { costSemantic: event.costSemantic } : {}),
          });
        }
      }

      const wasCancelled = session.abortController.signal.aborted;
      if (!wasCancelled) session.status = "completed";
      const reason = wasCancelled ? "cancelled" : "complete";
      channel.push({
        kind: "ca_session_ended",
        sessionId: session.sessionId,
        reason,
      });
      logger.info("session.end", {
        sessionId: session.sessionId,
        reason,
        durationMs: Date.now() - startedAt,
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (session.abortController.signal.aborted) {
        session.status = "cancelled";
        channel.push({
          kind: "ca_session_ended",
          sessionId: session.sessionId,
          reason: "cancelled",
        });
        logger.info("session.end", {
          sessionId: session.sessionId,
          reason: "cancelled",
          durationMs: Date.now() - startedAt,
        });
      } else {
        session.status = "errored";
        channel.push({
          kind: "ca_session_ended",
          sessionId: session.sessionId,
          reason: "error",
          errorMessage: errMsg,
        });
        logger.error("session.end", {
          sessionId: session.sessionId,
          reason: "error",
          error: errMsg,
          durationMs: Date.now() - startedAt,
        });
      }
    } finally {
      channel.close();
    }
  })();

  for await (const ev of channel) {
    push(ev);
    if (ev.kind === "ca_session_ended") break;
  }
  await drain;
  session.events.close();
}
