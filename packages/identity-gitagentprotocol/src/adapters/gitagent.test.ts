import { describe, expect, it } from "vitest";
import { gapToGitagentOptions } from "./gitagent.js";

describe("gapToGitagentOptions", () => {
  it("returns the workdir as dir", async () => {
    const { options } = await gapToGitagentOptions(
      { name: "x", version: "1.0.0" } as never,
      "/tmp/agent",
    );
    expect(options.dir).toBe("/tmp/agent");
    expect(options.model).toBeUndefined();
    expect(options.maxTurns).toBeUndefined();
  });

  it("forwards model and maxTurns when present", async () => {
    const { options } = await gapToGitagentOptions(
      {
        name: "x",
        version: "1.0.0",
        model: { preferred: "openai:gpt-4o-mini" },
        runtime: { max_turns: 12 },
      } as never,
      "/tmp/agent",
    );
    expect(options).toEqual({
      dir: "/tmp/agent",
      model: "openai:gpt-4o-mini",
      maxTurns: 12,
    });
  });

  it("maps manifest.model.constraints.temperature to a flat temperature field (Wedge 1.7)", async () => {
    const { options } = await gapToGitagentOptions(
      {
        name: "x",
        version: "1.0.0",
        model: { preferred: "anthropic:claude-sonnet-4-5", constraints: { temperature: 0.2 } },
      } as never,
      "/tmp/agent",
    );
    expect((options as { temperature?: number }).temperature).toBe(0.2);
  });

  it("omits temperature when not declared", async () => {
    const { options } = await gapToGitagentOptions(
      { name: "x", version: "1.0.0", model: { preferred: "anthropic:claude-sonnet-4-5" } } as never,
      "/tmp/agent",
    );
    expect((options as { temperature?: number }).temperature).toBeUndefined();
  });

  it("harden() sets requireHumanReview when compliance.supervision.human_in_the_loop is 'always' (Wedge 1.8)", async () => {
    const { harden } = await gapToGitagentOptions(
      {
        name: "x",
        version: "1.0.0",
        compliance: { supervision: { human_in_the_loop: "always" } },
      } as never,
      "/tmp/agent",
    );
    const merged = { dir: "/tmp/agent" };
    const hardened = harden(merged);
    expect((hardened as { requireHumanReview?: boolean }).requireHumanReview).toBe(true);
  });

  it("harden() leaves options untouched when no compliance directive present", async () => {
    const { harden } = await gapToGitagentOptions(
      { name: "x", version: "1.0.0" } as never,
      "/tmp/agent",
    );
    const merged = { dir: "/tmp/agent" };
    const hardened = harden(merged);
    expect((hardened as { requireHumanReview?: boolean }).requireHumanReview).toBeUndefined();
  });
});
