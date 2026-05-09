import { describe, expect, it } from "vitest";
import {
  CreateSessionBody,
  FsEditBody,
  FsMkdirBody,
  FsMoveBody,
  HealthResponse,
  PermissionDecisionBody,
  SendMessageBody,
  UserMessage,
} from "./harness-rest.js";

describe("REST schemas", () => {
  it("accepts a string-content user message", () => {
    const ok = UserMessage.safeParse({ role: "user", content: "hello" });
    expect(ok.success).toBe(true);
  });

  it("accepts a content-block user message", () => {
    const ok = UserMessage.safeParse({
      role: "user",
      content: [{ type: "text", text: "hello" }],
    });
    expect(ok.success).toBe(true);
  });

  it("rejects a non-user role", () => {
    const bad = UserMessage.safeParse({ role: "assistant", content: "no" });
    expect(bad.success).toBe(false);
  });

  it("CreateSessionBody requires engine + identity", () => {
    const ok = CreateSessionBody.safeParse({
      engine: "claude-agent-sdk",
      identity: { loader: "gitagentprotocol", source: { type: "git", url: "x" } },
    });
    expect(ok.success).toBe(true);
  });

  it("CreateSessionBody allows optional messages, envs, options", () => {
    const ok = CreateSessionBody.safeParse({
      engine: "e",
      identity: { loader: "l", source: { type: "local", path: "/x" } },
      messages: [{ role: "user", content: "hi" }],
      envs: { FOO: "bar" },
      options: { maxTurns: 5 },
    });
    expect(ok.success).toBe(true);
  });

  it("SendMessageBody round-trips", () => {
    const ok = SendMessageBody.safeParse({
      message: { role: "user", content: "more" },
    });
    expect(ok.success).toBe(true);
  });

  it("PermissionDecisionBody constrains decision to enum", () => {
    expect(PermissionDecisionBody.safeParse({ decision: "allow" }).success).toBe(true);
    expect(PermissionDecisionBody.safeParse({ decision: "approve" }).success).toBe(false);
  });

  it("FsEditBody requires both strings", () => {
    const ok = FsEditBody.safeParse({
      path: "x.txt",
      oldString: "a",
      newString: "b",
    });
    expect(ok.success).toBe(true);
    expect(FsEditBody.safeParse({ path: "x.txt", oldString: "a" }).success).toBe(false);
  });

  it("FsMkdirBody requires a non-empty path", () => {
    expect(FsMkdirBody.safeParse({ path: "" }).success).toBe(false);
    expect(FsMkdirBody.safeParse({ path: "dir" }).success).toBe(true);
  });

  it("FsMoveBody requires from and to", () => {
    expect(FsMoveBody.safeParse({ from: "a", to: "b" }).success).toBe(true);
    expect(FsMoveBody.safeParse({ from: "a" }).success).toBe(false);
  });

  it("HealthResponse echoes engines and loaders", () => {
    const ok = HealthResponse.safeParse({
      ok: true,
      version: "0.1.0",
      engines: {
        "claude-agent-sdk": {
          streamingInput: true,
          partialMessages: true,
          permissionCallback: true,
          sessions: true,
          budget: true,
        },
      },
      loaders: ["gitagentprotocol"],
    });
    expect(ok.success).toBe(true);
  });
});
