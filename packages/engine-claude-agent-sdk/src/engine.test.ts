import { describe, expect, it, vi } from "vitest";
import { ClaudeAgentEngine } from "./engine.js";

describe("ClaudeAgentEngine", () => {
  it("declares the expected capability set", () => {
    const e = new ClaudeAgentEngine();
    expect(e.name).toBe("claude-agent-sdk");
    expect(e.capabilities).toEqual({
      streamingInput: true,
      partialMessages: true,
      permissionCallback: true,
      sessions: true,
      budget: true,
    });
  });

  it("startSession returns an AsyncIterable (no real LLM call here)", () => {
    const e = new ClaudeAgentEngine();
    const ctrl = new AbortController();
    ctrl.abort();
    const stream = e.startSession({
      sessionId: "sess_test",
      options: {},
      workdir: "/tmp",
      envs: {},
      userMessageQueue: (async function* () {})(),
      onPermissionRequest: async () => ({ behavior: "deny", message: "n/a" }),
      abortSignal: ctrl.signal,
    });
    expect(typeof (stream as AsyncIterable<unknown>)[Symbol.asyncIterator]).toBe("function");
  });

  it("emits ca_usage_snapshot after each SDKResultMessage (issue #5)", async () => {
    // Mock @anthropic-ai/claude-agent-sdk's `query()` to yield a fixed
    // result-typed message carrying real-world usage shape.
    vi.doMock("@anthropic-ai/claude-agent-sdk", async () => ({
      query: async function* mockQuery() {
        yield { type: "assistant", message: { content: [{ type: "text", text: "hi" }] } };
        yield {
          type: "result",
          subtype: "success",
          duration_ms: 1234,
          num_turns: 1,
          result: "hello",
          total_cost_usd: 0.0301,
          usage: {
            input_tokens: 1000,
            output_tokens: 250,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 100,
          },
        };
      },
    }));

    vi.resetModules();
    const { ClaudeAgentEngine: PatchedEngine } = await import("./engine.js");

    const ctrl = new AbortController();
    const e = new PatchedEngine();
    const events: unknown[] = [];
    for await (const ev of e.startSession({
      sessionId: "sess_t",
      options: {},
      workdir: "/tmp",
      envs: {},
      userMessageQueue: (async function* () { yield { role: "user" as const, content: "hi" }; })(),
      onPermissionRequest: async () => ({ behavior: "deny", message: "n/a" }),
      abortSignal: ctrl.signal,
    })) {
      events.push(ev);
    }

    const usage = events.find((e) => (e as { kind?: string }).kind === "ca_usage_snapshot") as {
      kind: "ca_usage_snapshot";
      inputTokens?: number;
      outputTokens?: number;
      cacheReadInputTokens?: number;
      costUsd?: number;
      costSemantic?: "cumulative" | "delta";
    } | undefined;

    expect(usage).toBeDefined();
    expect(usage!.inputTokens).toBe(1000);
    expect(usage!.outputTokens).toBe(250);
    expect(usage!.cacheReadInputTokens).toBe(100);
    expect(usage!.costUsd).toBeCloseTo(0.0301, 6);
    expect(usage!.costSemantic).toBe("cumulative");

    vi.doUnmock("@anthropic-ai/claude-agent-sdk");
  });
});

describe("inheritEssentialHostEnv — Bedrock + POSIX passthrough", () => {
  // The Claude Agent SDK runs as a subprocess of the harness; for it to find
  // AWS Bedrock credentials via the standard SDK credential chain (IRSA token,
  // shared creds, profile) those env vars must be inherited from the host.
  // This regression test pins the allowlist so adding/removing entries is a
  // conscious decision.

  it("propagates POSIX + XDG basics when set", async () => {
    const { inheritEssentialHostEnv } = await import("./engine.js");
    const prev = { HOME: process.env.HOME, PATH: process.env.PATH, LANG: process.env.LANG };
    process.env.HOME = "/home/spike";
    process.env.PATH = "/spike/bin";
    process.env.LANG = "en_US.UTF-8";
    try {
      const out = inheritEssentialHostEnv();
      expect(out.HOME).toBe("/home/spike");
      expect(out.PATH).toBe("/spike/bin");
      expect(out.LANG).toBe("en_US.UTF-8");
    } finally {
      Object.assign(process.env, prev);
    }
  });

  it("propagates the Bedrock + AWS IRSA env vars", async () => {
    const { inheritEssentialHostEnv } = await import("./engine.js");
    const keys = [
      "CLAUDE_CODE_USE_BEDROCK",
      "AWS_REGION",
      "AWS_DEFAULT_REGION",
      "AWS_BEDROCK_MODEL_ID",
      "AWS_ROLE_ARN",
      "AWS_WEB_IDENTITY_TOKEN_FILE",
      "AWS_PROFILE",
      "AWS_SHARED_CREDENTIALS_FILE",
      "AWS_CONFIG_FILE",
    ];
    const prev: Record<string, string | undefined> = {};
    for (const k of keys) prev[k] = process.env[k];
    process.env.CLAUDE_CODE_USE_BEDROCK = "1";
    process.env.AWS_REGION = "us-west-2";
    process.env.AWS_DEFAULT_REGION = "us-east-1";
    process.env.AWS_BEDROCK_MODEL_ID = "anthropic.claude-sonnet-4-20250514-v1:0";
    process.env.AWS_ROLE_ARN = "arn:aws:iam::123456789012:role/spike";
    process.env.AWS_WEB_IDENTITY_TOKEN_FILE = "/var/run/secrets/eks.amazonaws.com/serviceaccount/token";
    process.env.AWS_PROFILE = "default";
    process.env.AWS_SHARED_CREDENTIALS_FILE = "/etc/aws/credentials";
    process.env.AWS_CONFIG_FILE = "/etc/aws/config";
    try {
      const out = inheritEssentialHostEnv();
      expect(out.CLAUDE_CODE_USE_BEDROCK).toBe("1");
      expect(out.AWS_REGION).toBe("us-west-2");
      expect(out.AWS_DEFAULT_REGION).toBe("us-east-1");
      expect(out.AWS_BEDROCK_MODEL_ID).toBe("anthropic.claude-sonnet-4-20250514-v1:0");
      expect(out.AWS_ROLE_ARN).toBe("arn:aws:iam::123456789012:role/spike");
      expect(out.AWS_WEB_IDENTITY_TOKEN_FILE).toBe(
        "/var/run/secrets/eks.amazonaws.com/serviceaccount/token",
      );
      expect(out.AWS_PROFILE).toBe("default");
      expect(out.AWS_SHARED_CREDENTIALS_FILE).toBe("/etc/aws/credentials");
      expect(out.AWS_CONFIG_FILE).toBe("/etc/aws/config");
    } finally {
      for (const k of keys) {
        if (prev[k] === undefined) delete process.env[k];
        else process.env[k] = prev[k]!;
      }
    }
  });

  it("omits keys that aren't set on the host (no empty-string leaks)", async () => {
    const { inheritEssentialHostEnv } = await import("./engine.js");
    const prev = process.env.AWS_BEDROCK_MODEL_ID;
    delete process.env.AWS_BEDROCK_MODEL_ID;
    try {
      const out = inheritEssentialHostEnv();
      expect("AWS_BEDROCK_MODEL_ID" in out).toBe(false);
    } finally {
      if (prev !== undefined) process.env.AWS_BEDROCK_MODEL_ID = prev;
    }
  });
});
