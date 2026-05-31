import type { CanUseTool, HookCallback, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import type { PermissionRequest } from "@open-gitagent/protocol";
import { classifyRisk } from "./risk.js";

/**
 * Bridges the Claude Agent SDK's `canUseTool` callback to the framework's
 * abstract `onPermissionRequest`. Pure factory — no side effects.
 *
 * The harness server wraps `onPermissionRequest` with HTTP plumbing; this
 * adapter just translates the call signatures so neither side knows about the other.
 */
export function buildCanUseTool(
  onPermissionRequest: (req: PermissionRequest) => Promise<PermissionResult>,
): CanUseTool {
  return async (toolName, input, opts) => {
    const callId = opts.toolUseID ?? `call_${cryptoRandomId()}`;
    const risk = classifyRisk(toolName, input);
    return onPermissionRequest({ callId, toolName, input, risk });
  };
}

/**
 * PreToolUse hook bridge — fires for every tool call regardless of
 * permissionMode (canUseTool is skipped in bypassPermissions, but
 * PreToolUse hooks always run and their deny overrides canUseTool).
 *
 * The same `onPermissionRequest` callback is reused — the harness uses
 * it for policy enforcement (SrsPolicyDecider gates here in
 * bypassPermissions sandboxes).
 */
export function buildPreToolUseHook(
  onPermissionRequest: (req: PermissionRequest) => Promise<PermissionResult>,
): HookCallback {
  return async (input, toolUseID) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    const callId = toolUseID ?? `call_${cryptoRandomId()}`;
    const toolName = input.tool_name;
    const toolInput = input.tool_input;
    const risk = classifyRisk(toolName, toolInput);
    const decision = await onPermissionRequest({ callId, toolName, input: toolInput, risk });
    if (decision.behavior === "deny") {
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: decision.message ?? "denied by policy",
        },
      };
    }
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
      },
    };
  };
}

function cryptoRandomId(): string {
  return Math.random().toString(36).slice(2, 10);
}
