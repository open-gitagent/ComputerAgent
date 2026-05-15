import { describe, expect, it } from "vitest";
import {
  HarnessProtocolError,
  UnknownEngineError,
  UnknownLoaderError,
  UnknownStoreError,
  asHarnessError,
} from "./errors.js";

function wireResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("asHarnessError", () => {
  it("returns UnknownEngineError when code is UNKNOWN_ENGINE and engine hint is set", async () => {
    const res = wireResponse(400, {
      error: {
        code: "UNKNOWN_ENGINE",
        message: "engine 'claud-agent-sdk' is not registered",
        details: { available: ["claude-agent-sdk", "gitagent"] },
      },
    });
    const err = await asHarnessError(res, { engine: "claud-agent-sdk" });
    expect(err).toBeInstanceOf(UnknownEngineError);
    expect(err).toBeInstanceOf(HarnessProtocolError);
    const e = err as UnknownEngineError;
    expect(e.requested).toBe("claud-agent-sdk");
    expect(e.available).toEqual(["claude-agent-sdk", "gitagent"]);
    expect(e.code).toBe("UNKNOWN_ENGINE");
    expect(e.status).toBe(400);
    // Edit-distance suggestion fires for a clear 1-char typo
    expect(e.message).toContain('Did you mean "claude-agent-sdk"');
    expect(e.message).toContain("Available: claude-agent-sdk, gitagent");
  });

  it("returns UnknownLoaderError when code is UNKNOWN_LOADER", async () => {
    const res = wireResponse(400, {
      error: {
        code: "UNKNOWN_LOADER",
        message: "loader 'gitagent-protocl' is not registered",
        details: { available: ["gitagentprotocol"] },
      },
    });
    const err = await asHarnessError(res, { loader: "gitagent-protocl" });
    expect(err).toBeInstanceOf(UnknownLoaderError);
    expect((err as UnknownLoaderError).available).toEqual(["gitagentprotocol"]);
  });

  it("returns UnknownStoreError when code is UNKNOWN_STORE", async () => {
    const res = wireResponse(400, {
      error: {
        code: "UNKNOWN_STORE",
        message: "session store 'flie' is not registered",
        details: { available: ["memory", "file"] },
      },
    });
    const err = await asHarnessError(res, { storeKind: "flie" });
    expect(err).toBeInstanceOf(UnknownStoreError);
    expect(err.message).toContain('Did you mean "file"');
  });

  it("omits suggestion when no close match exists", async () => {
    const res = wireResponse(400, {
      error: {
        code: "UNKNOWN_ENGINE",
        message: "engine 'xyzzy' is not registered",
        details: { available: ["claude-agent-sdk", "gitagent"] },
      },
    });
    const err = await asHarnessError(res, { engine: "xyzzy" });
    expect(err.message).not.toContain("Did you mean");
    expect(err.message).toContain("Available: claude-agent-sdk, gitagent");
  });

  it("falls back to base HarnessProtocolError for unrecognized codes", async () => {
    const res = wireResponse(409, {
      error: { code: "SOMETHING_ELSE", message: "weird conflict", details: { hint: "x" } },
    });
    const err = await asHarnessError(res);
    expect(err).toBeInstanceOf(HarnessProtocolError);
    expect(err).not.toBeInstanceOf(UnknownEngineError);
    const e = err as HarnessProtocolError;
    expect(e.code).toBe("SOMETHING_ELSE");
    expect(e.status).toBe(409);
    expect(e.details).toEqual({ hint: "x" });
  });

  it("falls back to plain Error for non-JSON bodies", async () => {
    const res = new Response("<html>500</html>", { status: 500 });
    const err = await asHarnessError(res);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(HarnessProtocolError);
    expect(err.message).toContain("500");
  });

  it("falls back to plain Error when JSON has no error envelope", async () => {
    const res = wireResponse(400, { something: "else" });
    const err = await asHarnessError(res);
    expect(err).not.toBeInstanceOf(HarnessProtocolError);
  });

  it("UnknownEngineError without matching available array still constructs cleanly", async () => {
    const res = wireResponse(400, {
      error: { code: "UNKNOWN_ENGINE", message: "no", details: {} },
    });
    const err = await asHarnessError(res, { engine: "foo" });
    expect(err).toBeInstanceOf(UnknownEngineError);
    expect((err as UnknownEngineError).available).toEqual([]);
    expect(err.message).toContain("Available: (none)");
  });
});
