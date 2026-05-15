import { describe, expect, it } from "vitest";
import type { ClaudeAgentOptions } from "@computeragent/protocol";
import { gapToClaudeAgentOptions } from "./claude-agent-sdk.js";
import type { GapManifest } from "../manifest.js";

const base: GapManifest = {
  name: "compliance-test",
  version: "1.0.0",
};

async function runHarden(
  manifest: GapManifest,
  callerOpts: Partial<ClaudeAgentOptions>,
): Promise<ClaudeAgentOptions> {
  const { options, harden } = await gapToClaudeAgentOptions(manifest, "/tmp/no-such");
  return harden({ ...options, ...callerOpts });
}

describe("manifest.model.constraints.temperature → opts.temperature (Wedge 1.7)", () => {
  it("maps a declared temperature to a flat opts.temperature field", async () => {
    const { options } = await gapToClaudeAgentOptions(
      { ...base, model: { preferred: "claude-sonnet-4-5-20250929", constraints: { temperature: 0.3 } } },
      "/tmp/no-such",
    );
    expect((options as ClaudeAgentOptions & { temperature?: number }).temperature).toBe(0.3);
  });

  it("omits temperature when not declared", async () => {
    const { options } = await gapToClaudeAgentOptions(
      { ...base, model: { preferred: "claude-sonnet-4-5-20250929" } },
      "/tmp/no-such",
    );
    expect((options as ClaudeAgentOptions & { temperature?: number }).temperature).toBeUndefined();
  });
});

describe("compliance.supervision.human_in_the_loop → permissionMode hardening", () => {
  it("'always' rewrites caller's bypassPermissions to default", async () => {
    const merged = await runHarden(
      { ...base, compliance: { supervision: { human_in_the_loop: "always" } } },
      { permissionMode: "bypassPermissions" },
    );
    expect(merged.permissionMode).toBe("default");
  });

  it("'destructive' also rewrites bypassPermissions to default", async () => {
    const merged = await runHarden(
      { ...base, compliance: { supervision: { human_in_the_loop: "destructive" } } },
      { permissionMode: "bypassPermissions" },
    );
    expect(merged.permissionMode).toBe("default");
  });

  it("'none' leaves caller's bypassPermissions alone", async () => {
    const merged = await runHarden(
      { ...base, compliance: { supervision: { human_in_the_loop: "none" } } },
      { permissionMode: "bypassPermissions" },
    );
    expect(merged.permissionMode).toBe("bypassPermissions");
  });

  it("missing compliance block leaves caller's options alone", async () => {
    const merged = await runHarden(base, { permissionMode: "bypassPermissions" });
    expect(merged.permissionMode).toBe("bypassPermissions");
  });

  it("'always' does not change a caller's already-strict permissionMode", async () => {
    const merged = await runHarden(
      { ...base, compliance: { supervision: { human_in_the_loop: "always" } } },
      { permissionMode: "default" },
    );
    expect(merged.permissionMode).toBe("default");
  });

  it("'always' does not change a caller's 'acceptEdits' (non-bypass) mode", async () => {
    // Only `bypassPermissions` skips the canUseTool callback — other modes are
    // already gated, so leaving them is correct.
    const merged = await runHarden(
      { ...base, compliance: { supervision: { human_in_the_loop: "always" } } },
      { permissionMode: "acceptEdits" },
    );
    expect(merged.permissionMode).toBe("acceptEdits");
  });

  it("non-permission-mode caller options pass through untouched", async () => {
    const merged = await runHarden(
      { ...base, compliance: { supervision: { human_in_the_loop: "always" } } },
      { model: "from-caller", maxTurns: 99 },
    );
    expect(merged.model).toBe("from-caller");
    expect(merged.maxTurns).toBe(99);
  });
});
