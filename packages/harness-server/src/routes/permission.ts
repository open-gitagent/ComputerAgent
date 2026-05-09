import { Hono } from "hono";
import { PermissionDecisionBody } from "@computeragent/protocol";
import type { PermissionResult } from "@computeragent/protocol";
import type { ServerContext } from "../app.js";
import { BadRequest, NotFound } from "../error-mapper.js";

/**
 * POST /v1/sessions/:id/permission/:callId — answer a pending permission request.
 *
 * The engine called `onPermissionRequest`; the framework holds the resolver
 * promise open. This route resolves it. The Claude Agent SDK / gitclaw
 * `PermissionResult` shape is what we hand back to the engine.
 */
export function permissionRoute(ctx: ServerContext): Hono {
  const app = new Hono();

  app.post("/sessions/:id/permission/:callId", async (c) => {
    const id = c.req.param("id");
    const callId = c.req.param("callId");
    const session = ctx.registry.get(id);
    if (!session) throw NotFound("session", id);

    const body = PermissionDecisionBody.parse(await c.req.json());
    const result = toPermissionResult(body);

    const ok = session.resolvePermission(callId, result);
    if (!ok) {
      throw BadRequest(
        "UNKNOWN_CALL_ID",
        `no pending permission request for callId '${callId}' on session '${id}'`,
      );
    }
    return c.json({ ok: true });
  });

  return app;
}

function toPermissionResult(body: {
  decision: "allow" | "deny" | "modify";
  input?: unknown;
  reason?: string;
}): PermissionResult {
  if (body.decision === "deny") {
    return {
      behavior: "deny",
      message: body.reason ?? "denied by user",
      interrupt: false,
    };
  }
  // allow + modify both produce SDK's "allow" shape; modify carries updatedInput.
  const updatedInput = (body.decision === "modify" ? body.input : body.input) as Record<string, unknown> | undefined;
  return {
    behavior: "allow",
    updatedInput: updatedInput ?? {},
    updatedPermissions: [],
  };
}
