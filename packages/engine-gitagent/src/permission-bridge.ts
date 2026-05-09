import type { GCHookResult, GCPreToolUseContext } from "gitclaw";
import type { PermissionRequest, PermissionResult } from "@computeragent/protocol";

/**
 * Bridges gitclaw's `preToolUse` hook to the framework's abstract
 * `onPermissionRequest`. Pure factory — no side effects.
 *
 * Claude Agent SDK's `PermissionResult` is the canonical shape across our engines;
 * we translate it down to gitclaw's `GCHookResult` here so neither side leaks
 * the other's vocabulary into the framework.
 */
export function buildPreToolUse(
  onPermissionRequest: (req: PermissionRequest) => Promise<PermissionResult>,
): (ctx: GCPreToolUseContext) => Promise<GCHookResult> {
  return async (ctx) => {
    const result = await onPermissionRequest({
      callId: `${ctx.sessionId}:${ctx.toolName}:${nonce()}`,
      toolName: ctx.toolName,
      input: ctx.args,
    });
    return toGCHookResult(result, ctx.args);
  };
}

function toGCHookResult(
  result: PermissionResult,
  originalArgs: Record<string, unknown>,
): GCHookResult {
  if (result.behavior === "allow") {
    const updated = (result as { updatedInput?: Record<string, unknown> }).updatedInput;
    if (updated && updated !== originalArgs) {
      return { action: "modify", args: updated };
    }
    return { action: "allow" };
  }
  // behavior === "deny"
  const message = (result as { message?: string }).message ?? "denied";
  return { action: "block", reason: message };
}

function nonce(): string {
  return Math.random().toString(36).slice(2, 10);
}
