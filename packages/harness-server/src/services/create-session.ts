import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Attachment, CreateSessionBody } from "@open-gitagent/protocol";
import { Session } from "../session.js";
import { SrsPolicyDecider } from "./srs-policy-decider.js";
import { SessionRegistry } from "../registry.js";
import { BadRequest } from "../error-mapper.js";
import { PathEscapeError } from "../path-jail.js";
import { writeBytes } from "./workspace-fs.js";
import type { ServerDeps } from "../app.js";
import { resolveStore } from "../stores/registry.js";
import { wrapValidatingStore } from "../stores/validating-store.js";

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
  const workdir = await makeWorkdir(sessionId, Boolean(body.sessionStore));

  const result = await loader.load({
    source: body.identity.source,
    targetEngine: body.engine,
    workdir,
  });

  // Materialize caller-supplied attachments on top of the loader's output.
  // Order matters: loader runs first (GAP repo files), then attachments
  // overlay — so a per-request file overrides a repo file with the same
  // name. Path-jailed by writeBytes; out-of-workdir paths → 400.
  if (body.attachments && body.attachments.length > 0) {
    await materializeAttachments(workdir, body.attachments, deps.logger);
  }

  const merged = mergeEngineOptions(result.options, body.options);
  const final = result.harden ? result.harden(merged) : merged;

  const rawStore = body.sessionStore
    ? resolveStore(deps.sessionStores, body.sessionStore)
    : undefined;
  const sessionStore = rawStore && deps.validateStoreEntries
    ? wrapValidatingStore(rawStore)
    : rawStore;

  // Build a policy decider from wire-side config. Only "srs" is supported
  // today — extend by branching on body.policy.kind here.
  const policyDecider = body.policy
    ? new SrsPolicyDecider({
        kind: "srs",
        endpoint: body.policy.endpoint,
        apiKey: body.policy.apiKey,
        policyId: body.policy.policyId,
        principalId: body.policy.principalId,
      })
    : undefined;

  const session = new Session(
    sessionId,
    body.engine,
    body.identity.loader,
    workdir,
    final,
    body.envs ?? {},
    engine.capabilities,
    result.metadata,
    result.cleanup,
    1000,
    deps.auditSink,
    sessionStore,
    policyDecider,
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
  deps.logger.info("session.create", {
    sessionId,
    engine: body.engine,
    loader: body.identity.loader,
    identity: result.metadata.name,
    streamingInput: Boolean(body.streamingInput),
    sessionStore: body.sessionStore?.kind,
  });
  return session;
}

async function makeWorkdir(sessionId: string, stable: boolean): Promise<string> {
  const base = join(tmpdir(), "computeragent-sessions");
  await mkdir(base, { recursive: true });
  if (stable) {
    // Stable per-sessionId workdir. Required when a sessionStore is in play
    // because the Claude Agent SDK derives its internal `projectKey` from
    // the cwd path — for cross-process resume to align, two invocations
    // under the same sessionId must use the same cwd. Random mkdtemp
    // suffixes break that alignment.
    const dir = join(base, sessionId);
    await mkdir(dir, { recursive: true });
    return dir;
  }
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

/**
 * Write each attachment into the workdir before the engine starts.
 *
 * Path-jailed via `writeBytes` — relative paths that resolve outside the
 * workdir are rejected with 400 PATH_ESCAPE. Binary uploads use
 * `encoding: "base64"`; text uses `encoding: "utf8"` (default).
 *
 * One log line per attachment so the deployment is auditable.
 */
async function materializeAttachments(
  workdir: string,
  attachments: readonly Attachment[],
  logger: ServerDeps["logger"],
): Promise<void> {
  for (const att of attachments) {
    const encoding = att.encoding ?? "utf8";
    const bytes =
      encoding === "base64" ? Buffer.from(att.content, "base64") : Buffer.from(att.content, "utf8");
    try {
      const { size } = await writeBytes(workdir, att.path, bytes);
      logger.info("session.attachment.written", { path: att.path, bytes: size, encoding });
    } catch (err) {
      if (err instanceof PathEscapeError) {
        throw BadRequest(
          "PATH_ESCAPE",
          `attachment path '${err.attempted}' resolves outside the session workdir`,
          { attempted: err.attempted },
        );
      }
      throw err;
    }
  }
}
