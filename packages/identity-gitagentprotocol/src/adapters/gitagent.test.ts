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
});
