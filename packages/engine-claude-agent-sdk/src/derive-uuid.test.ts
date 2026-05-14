import { describe, expect, it } from "vitest";
import { deriveEngineUuid } from "./derive-uuid.js";

describe("deriveEngineUuid", () => {
  it("is deterministic — same input produces same UUID", () => {
    expect(deriveEngineUuid("sess_abc123")).toBe(deriveEngineUuid("sess_abc123"));
  });

  it("different inputs produce different UUIDs", () => {
    expect(deriveEngineUuid("sess_one")).not.toBe(deriveEngineUuid("sess_two"));
  });

  it("output is an RFC4122 v5 UUID", () => {
    const uuid = deriveEngineUuid("sess_xyz");
    expect(uuid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("works for non-prefixed sessionIds too", () => {
    const uuid = deriveEngineUuid("just-a-string");
    expect(uuid).toMatch(/^[0-9a-f-]{36}$/);
  });
});
