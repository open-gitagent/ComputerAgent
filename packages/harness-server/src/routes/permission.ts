import { Hono } from "hono";
import { PermissionDecisionBody } from "@open-gitagent/protocol";
import type { PermissionResult } from "@open-gitagent/protocol";
import type { ServerContext } from "../app.js";
import { BadRequest, NotFound } from "../error-mapper.js";

/**
 * POST /v1/sessions/:id/permission/:callId — answer a pending permission request.
 *
 * The engine called `onPermissionRequest`; the framework holds the resolver
 * promise open. This route resolves it. The Claude Agent SDK / gitclaw
 * `PermissionResult` shape is what we hand back to the engine.
 *
 * The wire-level body is small ({decision, input?, reason?}). The translation
 * happens INSIDE `session.resolvePermission` so it can substitute the original
 * tool input when the client just says `{ decision: "allow" }` (no explicit
 * input). Otherwise the engine sees `updatedInput: {}` and tools crash with
 * missing-arg errors.
 */
export function permissionRoute(ctx: ServerContext): Hono {
  const app = new Hono();

  app.post("/sessions/:id/permission/:callId", async (c) => {
    const id = c.req.param("id");
    const callId = c.req.param("callId");
    ctx.deps.logger.debug("http.request", { method: "POST", path: "/v1/sessions/:id/permission/:callId", sessionId: id, callId });
    const session = ctx.registry.get(id);
    if (!session) throw NotFound("session", id);

    const body = PermissionDecisionBody.parse(await c.req.json());

    const ok = session.resolvePermission(callId, (originalInput) => bodyToResult(body, originalInput));
    if (!ok) {
      throw BadRequest(
        "UNKNOWN_CALL_ID",
        `no pending permission request for callId '${callId}' on session '${id}'`,
      );
    }
    ctx.deps.logger.info("session.permission_decision", { sessionId: id, callId, decision: body.decision });
    return c.json({ ok: true });
  });

  return app;
}

function bodyToResult(
  body: { decision: "allow" | "deny" | "modify"; input?: unknown; reason?: string },
  originalInput: unknown,
): PermissionResult {
  if (body.decision === "deny") {
    return {
      behavior: "deny",
      message: body.reason ?? "denied by user",
      interrupt: false,
    };
  }
  // allow / modify both map to SDK's "allow" with updatedInput. The body's
  // explicit input wins; if absent, we preserve the engine's original args so
  // tools receive what the LLM actually asked for.
  const inputToUse = body.input !== undefined ? body.input : originalInput;
  return {
    behavior: "allow",
    updatedInput: (inputToUse as Record<string, unknown> | null) ?? {},
    updatedPermissions: [],
  };
}
