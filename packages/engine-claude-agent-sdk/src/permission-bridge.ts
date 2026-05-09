import type { CanUseTool, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import type { PermissionRequest } from "@computeragent/protocol";

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
    return onPermissionRequest({ callId, toolName, input });
  };
}

function cryptoRandomId(): string {
  return Math.random().toString(36).slice(2, 10);
}
