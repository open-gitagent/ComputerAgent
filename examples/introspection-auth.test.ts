// Unit test for makeApiKeyVerifier — the ComputerAgent server's API-key
// verifier. Injects a fake fetch (the verifier accepts `fetchImpl`) and asserts:
// active → principal + cache hit on the 2nd call; inactive/non-200/throw →
// null (fail-closed) + negative caching; LRU eviction; and the exact request
// shape (service bearer + {key} body).

import { describe, expect, it, vi } from "vitest";
import { makeApiKeyVerifier } from "./introspection-auth.ts";

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
