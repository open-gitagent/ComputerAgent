import { describe, expect, it } from "vitest";
import { MockEngine, MockLoader } from "@computeragent/testing";
import { createHarnessServer } from "./app.js";

describe("createHarnessServer", () => {
  it("rejects construction without engines", () => {
    expect(() =>
      createHarnessServer({ engines: {}, identityLoaders: { mock: new MockLoader() } }),
    ).toThrow(/engine/);
  });

  it("rejects construction without identity loaders", () => {
    expect(() =>
      createHarnessServer({ engines: { mock: new MockEngine([]) }, identityLoaders: {} }),
    ).toThrow(/loader/);
  });

  it("constructs successfully with one of each", () => {
    const app = createHarnessServer({
      engines: { mock: new MockEngine([]) },
      identityLoaders: { mock: new MockLoader() },
    });
    expect(app).toBeDefined();
  });
});

describe("GET /v1/health", () => {
  it("returns version + capabilities of registered engines + loader names", async () => {
    const app = createHarnessServer({
      engines: { mock: new MockEngine([]) },
      identityLoaders: { mock: new MockLoader() },
    });
    const res = await app.request("/v1/health");
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.version).toBeDefined();
    expect(body.engines).toMatchObject({
      mock: {
        streamingInput: true,
        partialMessages: true,
        permissionCallback: true,
        sessions: true,
        budget: true,
      },
    });
    expect(body.loaders).toEqual(["mock"]);
  });

  it("404s on an unknown path", async () => {
    const app = createHarnessServer({
      engines: { mock: new MockEngine([]) },
      identityLoaders: { mock: new MockLoader() },
    });
    const res = await app.request("/v1/nope");
    expect(res.status).toBe(404);
  });
});
