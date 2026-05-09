import { describe, expect, it } from "vitest";
import {
  CaPermissionRequestEvent,
  CaSessionEndedEvent,
  CaSessionStartedEvent,
  CaUsageSnapshotEvent,
  HarnessEvent,
  SdkMessageEvent,
} from "./sse-events.js";

const sessionId = "sess_01";

describe("SSE event schemas", () => {
  it("parses sdk_message with opaque payload", () => {
    const ok = SdkMessageEvent.safeParse({
      kind: "sdk_message",
      sessionId,
      payload: { type: "assistant", whatever: 1 },
    });
    expect(ok.success).toBe(true);
  });

  it("parses ca_session_started with capabilities", () => {
    const ok = CaSessionStartedEvent.safeParse({
      kind: "ca_session_started",
      sessionId,
      engine: "claude-agent-sdk",
      identity: { name: "x", version: "0.1.0" },
      capabilities: {
        streamingInput: true,
        partialMessages: true,
        permissionCallback: true,
        sessions: true,
        budget: true,
      },
    });
    expect(ok.success).toBe(true);
  });

  it("parses ca_permission_request", () => {
    const ok = CaPermissionRequestEvent.safeParse({
      kind: "ca_permission_request",
      sessionId,
      callId: "call_1",
      toolName: "Bash",
      input: { command: "ls" },
      risk: "low",
    });
    expect(ok.success).toBe(true);
  });

  it("parses ca_usage_snapshot with optional fields", () => {
    const ok = CaUsageSnapshotEvent.safeParse({
      kind: "ca_usage_snapshot",
      sessionId,
      costUsd: 0.04,
    });
    expect(ok.success).toBe(true);
  });

  it("parses ca_session_ended with reason", () => {
    const ok = CaSessionEndedEvent.safeParse({
      kind: "ca_session_ended",
      sessionId,
      reason: "complete",
    });
    expect(ok.success).toBe(true);
  });

  it("HarnessEvent narrows by kind", () => {
    const parsed = HarnessEvent.safeParse({
      kind: "ca_session_ended",
      sessionId,
      reason: "cancelled",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.kind === "ca_session_ended") {
      // type-narrowing works
      expect(parsed.data.reason).toBe("cancelled");
    }
  });

  it("HarnessEvent rejects unknown kind", () => {
    const bad = HarnessEvent.safeParse({ kind: "garbage", sessionId });
    expect(bad.success).toBe(false);
  });
});
