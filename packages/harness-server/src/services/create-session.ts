import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { CreateSessionBody } from "@computeragent/protocol";
import { Session } from "../session.js";
import { SessionRegistry } from "../registry.js";
import { BadRequest } from "../error-mapper.js";
import type { ServerDeps } from "../app.js";

/**
 * Orchestrates session creation: resolves engine + loader, materializes the workdir,
 * runs the loader, registers the session.
 *
 * Pure orchestration — no HTTP, no SSE. Used by both `/v1/chat` and `/v1/sessions`.
 */
export async function createSession(
  deps: ServerDeps,
  registry: SessionRegistry,
  body: CreateSessionBody,
): Promise<Session> {
  const engine = deps.engines[body.engine];
  if (!engine) {
    throw BadRequest("UNKNOWN_ENGINE", `engine '${body.engine}' is not registered`, {
      available: Object.keys(deps.engines),
    });
  }
  const loader = deps.identityLoaders[body.identity.loader];
  if (!loader) {
    throw BadRequest("UNKNOWN_LOADER", `identity loader '${body.identity.loader}' is not registered`, {
      available: Object.keys(deps.identityLoaders),
    });
  }

  const sessionId = body.sessionId ?? `sess_${randomUUID().slice(0, 12)}`;
  const workdir = await makeWorkdir(sessionId);

  const result = await loader.load({
    source: body.identity.source,
    targetEngine: body.engine,
    workdir,
  });

  const session = new Session(
    sessionId,
    body.engine,
    body.identity.loader,
    workdir,
    mergeEngineOptions(result.options, body.options),
    body.envs ?? {},
    engine.capabilities,
    result.metadata,
    result.cleanup,
    1000,
    deps.auditSink,
  );

  // Initial messages from the body get enqueued immediately. The engine sees them
  // when it starts pulling from the queue.
  if (body.messages) {
    for (const m of body.messages) session.pushUserMessage(m);
  }

  // Default: one-shot. Close the user-input queue so the engine ends naturally
  // after handling the initial messages. Long-lived sessions opt in via
  // `streamingInput: true` and must call `POST /end-input` themselves.
  if (!body.streamingInput) {
    session.endUserMessages();
  }

  registry.add(session);
  return session;
}

async function makeWorkdir(sessionId: string): Promise<string> {
  const base = join(tmpdir(), "computeragent-sessions");
  await mkdir(base, { recursive: true });
  return mkdtemp(join(base, `${sessionId}-`));
}

/**
 * Merge caller-supplied options (from the request body) onto the loader's options.
 * Caller wins on conflicts — that's the contract: identity loader produces a base,
 * caller refines per-call (e.g. overriding model, maxTurns, permissionMode).
 *
 * Both inputs are `unknown` because EngineDriver<TOptions> is generic; if either
 * isn't a plain object we just take the more specific one.
 */
function mergeEngineOptions(loaderOpts: unknown, bodyOpts: Record<string, unknown> | undefined): unknown {
  if (!bodyOpts) return loaderOpts;
  if (!loaderOpts || typeof loaderOpts !== "object" || Array.isArray(loaderOpts)) return bodyOpts;
  return { ...(loaderOpts as Record<string, unknown>), ...bodyOpts };
}
