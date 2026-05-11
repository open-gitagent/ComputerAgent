import { describe, expect, it } from "vitest";
import { renderEventLine } from "./output.js";

const sid = "sess_test";

describe("renderEventLine", () => {
  it("renders ca_session_started", () => {
    const line = renderEventLine({
      kind: "ca_session_started",
      sessionId: sid,
      engine: "claude-agent-sdk",
      identity: { name: "test", version: "0.1.0" },
      capabilities: {
        streamingInput: true,
        partialMessages: true,
        permissionCallback: true,
        sessions: true,
        budget: true,
      },
    });
    expect(line).toContain("session sess_test");
    expect(line).toContain("engine=claude-agent-sdk");
    expect(line).toContain("identity=test@0.1.0");
  });

  it("renders ca_session_ended with reason", () => {
    const line = renderEventLine({ kind: "ca_session_ended", sessionId: sid, reason: "complete" });
    expect(line).toContain("ended");
    expect(line).toContain("complete");
  });

  it("renders ca_permission_request with callId + tool", () => {
    const line = renderEventLine({
      kind: "ca_permission_request",
      sessionId: sid,
      callId: "call_1",
      toolName: "Bash",
      input: { cmd: "ls" },
    });
    expect(line).toContain("call_1");
    expect(line).toContain("Bash");
  });

  it("renders sdk_message result", () => {
    const line = renderEventLine({
      kind: "sdk_message",
      sessionId: sid,
      payload: { type: "result", result: "all done" },
    });
    expect(line).toContain("result");
    expect(line).toContain("all done");
  });

  it("returns null for sdk_message stream_event (too noisy)", () => {
    const line = renderEventLine({
      kind: "sdk_message",
      sessionId: sid,
      payload: { type: "stream_event", event: { type: "content_block_delta" } },
    });
    expect(line).toBeNull();
  });

  it("renders ca_usage_snapshot with cost + tokens", () => {
    const line = renderEventLine({
      kind: "ca_usage_snapshot",
      sessionId: sid,
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 0.0123,
    });
    expect(line).toContain("100in/50out");
    expect(line).toContain("$0.0123");
  });
});
