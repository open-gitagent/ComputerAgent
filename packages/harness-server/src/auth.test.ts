import { describe, expect, it } from "vitest";
import { MockEngine, MockLoader } from "@computeragent/testing";
import { createHarnessServer } from "./app.js";
import { sharedSecretAuth, bearerToken, type AuthHandler } from "./auth.js";

function makeApp(authHandler: AuthHandler | undefined) {
  return createHarnessServer({
    engines: { mock: new MockEngine([{ kind: "emit", payload: { type: "x" } }]) },
    identityLoaders: { mock: new MockLoader({ metadata: { name: "test", version: "0.0.1" } }) },
    ...(authHandler ? { authHandler } : {}),
  });
}

const baseBody = {
  engine: "mock",
  identity: { loader: "mock", source: { type: "local", path: "/tmp" } },
};

describe("AuthHandler", () => {
  it("no handler set: all requests pass (loopback default)", async () => {
    const app = makeApp(undefined);
    const res = await app.request("/v1/health");
    expect(res.status).toBe(200);
  });

  it("missing Authorization header: 401 UNAUTHORIZED", async () => {
    const app = makeApp(sharedSecretAuth("s3cret"));
    const res = await app.request("/v1/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(baseBody),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("wrong token: 401", async () => {
    const app = makeApp(sharedSecretAuth("s3cret"));
    const res = await app.request("/v1/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer wrong" },
      body: JSON.stringify(baseBody),
    });
    expect(res.status).toBe(401);
  });

  it("correct token: request passes", async () => {
    const app = makeApp(sharedSecretAuth("s3cret"));
    const res = await app.request("/v1/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer s3cret" },
      body: JSON.stringify(baseBody),
    });
    expect(res.status).toBe(201);
  });

  it("/v1/health is public by default — no auth required", async () => {
    const app = makeApp(sharedSecretAuth("s3cret"));
    const res = await app.request("/v1/health");
    expect(res.status).toBe(200);
  });

  it("authPublicPaths overrides the default public set", async () => {
    const app = createHarnessServer({
      engines: { mock: new MockEngine([{ kind: "emit", payload: { type: "x" } }]) },
      identityLoaders: { mock: new MockLoader({ metadata: { name: "test", version: "0.0.1" } }) },
      authHandler: sharedSecretAuth("s3cret"),
      authPublicPaths: [],  // even health requires auth now
    });
    const res = await app.request("/v1/health");
    expect(res.status).toBe(401);
  });

  it("custom bearerToken verifier sees the token and can return scopes", async () => {
    let seenToken: string | undefined;
    const handler = bearerToken((t) => {
      seenToken = t;
      return t === "alpha" ? { principal: "alice", scopes: ["read", "write"] } : null;
    });
    const app = makeApp(handler);
    const res = await app.request("/v1/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer alpha" },
      body: JSON.stringify(baseBody),
    });
    expect(res.status).toBe(201);
    expect(seenToken).toBe("alpha");
  });
});
