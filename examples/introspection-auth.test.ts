// Unit test for makeApiKeyVerifier — the ComputerAgent server's API-key
// verifier. Injects a fake fetch (the verifier accepts `fetchImpl`) and asserts:
// active → principal + cache hit on the 2nd call; inactive/non-200/throw →
// null (fail-closed) + negative caching; LRU eviction; and the exact request
// shape (service bearer + {key} body).

import { describe, expect, it, vi } from "vitest";
import {
  makeApiKeyVerifier,
  requiredPermissionFor,
  principalHasPermission,
  type ApiKeyPrincipal,
} from "./introspection-auth.ts";

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as unknown as Response;
}

const base = { url: "http://agentos/keys/introspect", serviceSecret: "svc-secret" };

describe("makeApiKeyVerifier", () => {
  it("returns the principal for an active key and sends the right request", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ active: true, principal: "key_1", scopes: ["*"] }));
    const verify = makeApiKeyVerifier({ ...base, fetchImpl: fetchImpl as unknown as typeof fetch });

    const r = await verify("cak_abc");
    expect(r).toEqual({ principal: "key_1", scopes: ["*"] });

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(base.url);
    expect((init as any).method).toBe("POST");
    expect((init as any).headers.authorization).toBe("Bearer svc-secret");
    expect(JSON.parse((init as any).body)).toEqual({ key: "cak_abc" });
  });

  it("captures resolved permissions + group from the introspection response", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        active: true,
        principal: "key_1",
        permissions: ["agents:run", "agents:read"],
        group: "team-a",
        scopes: ["*"],
      }),
    );
    const verify = makeApiKeyVerifier({ ...base, fetchImpl: fetchImpl as unknown as typeof fetch });

    const r = await verify("cak_abc");
    expect(r).toEqual({
      principal: "key_1",
      permissions: ["agents:run", "agents:read"],
      group: "team-a",
      scopes: ["*"],
    });
  });

  it("leaves permissions undefined when the response omits it (old AgentOS)", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ active: true, principal: "key_1" }));
    const verify = makeApiKeyVerifier({ ...base, fetchImpl: fetchImpl as unknown as typeof fetch });
    const r = await verify("cak_abc");
    expect(r?.permissions).toBeUndefined();
  });

  it("caches a positive result (no 2nd fetch within TTL)", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ active: true, principal: "key_1" }));
    const verify = makeApiKeyVerifier({ ...base, fetchImpl: fetchImpl as unknown as typeof fetch });
    await verify("cak_abc");
    await verify("cak_abc");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("returns null for an inactive key and caches the negative", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ active: false }));
    const verify = makeApiKeyVerifier({ ...base, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await verify("cak_bad")).toBeNull();
    expect(await verify("cak_bad")).toBeNull();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("fails closed on a non-200 response", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, false, 500));
    const verify = makeApiKeyVerifier({ ...base, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await verify("cak_abc")).toBeNull();
  });

  it("fails closed when fetch throws (network error / timeout)", async () => {
    const fetchImpl = vi.fn(async () => { throw new Error("ECONNREFUSED"); });
    const verify = makeApiKeyVerifier({ ...base, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await verify("cak_abc")).toBeNull();
  });

  it("evicts the oldest entry past cacheMax", async () => {
    const fetchImpl = vi.fn(async (_u: unknown, init: any) => {
      const key = JSON.parse(init.body).key;
      return jsonResponse({ active: true, principal: `p_${key}` });
    });
    const verify = makeApiKeyVerifier({
      ...base,
      cacheMax: 1,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await verify("cak_A"); // caches A
    await verify("cak_B"); // evicts A, caches B
    await verify("cak_A"); // A re-fetched
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});

describe("requiredPermissionFor", () => {
  it("maps GET → agents:read", () => {
    expect(requiredPermissionFor("GET", "/sandboxes")).toBe("agents:read");
    expect(requiredPermissionFor("get", "/sandboxes/abc/artifact")).toBe("agents:read");
  });

  it("maps execute/mutate methods → agents:run", () => {
    expect(requiredPermissionFor("POST", "/run")).toBe("agents:run");
    expect(requiredPermissionFor("POST", "/sandboxes/abc/chat")).toBe("agents:run");
    expect(requiredPermissionFor("DELETE", "/sandboxes/abc")).toBe("agents:run");
  });
});

describe("principalHasPermission", () => {
  const withPerms = (permissions?: string[]): ApiKeyPrincipal => ({ principal: "key_1", ...(permissions ? { permissions } : {}) });

  it("allows when the required permission is held", () => {
    expect(principalHasPermission(withPerms(["agents:run", "agents:read"]), "agents:run")).toBe(true);
  });

  it("allows anything for the wildcard (admin key)", () => {
    expect(principalHasPermission(withPerms(["*"]), "agents:run")).toBe(true);
    expect(principalHasPermission(withPerms(["*"]), "agents:read")).toBe(true);
  });

  it("denies a viewer key (read-only) from a run route", () => {
    expect(principalHasPermission(withPerms(["agents:read"]), "agents:run")).toBe(false);
  });

  it("denies when the key has an empty permission set", () => {
    expect(principalHasPermission(withPerms([]), "agents:run")).toBe(false);
  });

  it("back-compat: allows when permissions is undefined (old AgentOS)", () => {
    expect(principalHasPermission(withPerms(undefined), "agents:run")).toBe(true);
  });

  it("returns true when no permission is required (null)", () => {
    expect(principalHasPermission(withPerms(["agents:read"]), null)).toBe(true);
  });
});
