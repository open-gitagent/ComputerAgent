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
    result.options,
    body.envs ?? {},
    engine.capabilities,
    result.metadata,
    result.cleanup,
  );

  // Initial messages from the body get enqueued immediately. The engine sees them
  // when it starts pulling from the queue.
  if (body.messages) {
    for (const m of body.messages) session.pushUserMessage(m);
  }

  registry.add(session);
  return session;
}

async function makeWorkdir(sessionId: string): Promise<string> {
  const base = join(tmpdir(), "computeragent-sessions");
  await mkdir(base, { recursive: true });
  return mkdtemp(join(base, `${sessionId}-`));
}
