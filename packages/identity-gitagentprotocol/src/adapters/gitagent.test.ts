import { describe, expect, it } from "vitest";
import { gapToGitagentOptions } from "./gitagent.js";

describe("gapToGitagentOptions", () => {
  it("returns the workdir as dir", async () => {
    const opts = await gapToGitagentOptions(
      { name: "x", version: "1.0.0" } as never,
      "/tmp/agent",
    );
    expect(opts.dir).toBe("/tmp/agent");
    expect(opts.model).toBeUndefined();
    expect(opts.maxTurns).toBeUndefined();
  });

  it("forwards model and maxTurns when present", async () => {
    const opts = await gapToGitagentOptions(
      {
        name: "x",
        version: "1.0.0",
        model: { preferred: "openai:gpt-4o-mini" },
        runtime: { max_turns: 12 },
      } as never,
      "/tmp/agent",
    );
    expect(opts).toEqual({
      dir: "/tmp/agent",
      model: "openai:gpt-4o-mini",
      maxTurns: 12,
    });
  });
});
