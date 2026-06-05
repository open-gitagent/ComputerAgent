// API-key verifier for the ComputerAgent server.
//
// AgentOS issues + stores keys; this server validates a presented key by POSTing
// it to AgentOS's introspection endpoint (RFC 7662 style). The call carries a
// service secret so the endpoint is not an open key-validity oracle.
//
// A short in-memory TTL+LRU cache keyed by sha256(token) avoids a network hop on
// every request and bounds revocation latency. The verifier FAILS CLOSED: any
// non-200, network error, or timeout returns null (→ the caller 401s).

import { createHash } from "node:crypto";

export interface ApiKeyVerifierOptions {
  /** Full introspection URL, e.g. http://agentos:8788/agentos/api/keys/introspect */
  url: string;
  /** Shared service secret — sent to AgentOS as `Authorization: Bearer`. */
  serviceSecret: string;
  /** How long a positive (active) result is cached. Default 30s — also the
   *  upper bound on how long a revoked key keeps working. */
  positiveTtlMs?: number;
  /** How long a negative result is cached. Short so a just-minted key starts
   *  working quickly and a flapping AgentOS doesn't get a fetch storm. */
  negativeTtlMs?: number;
  /** Max cached entries (bounded LRU) — prevents memory exhaustion from an
   *  attacker spraying distinct bogus tokens. */
  cacheMax?: number;
  /** Introspection request timeout. */
  timeoutMs?: number;
  /** Injectable for tests; defaults to global fetch (Node 20+). */
  fetchImpl?: typeof fetch;
  logger?: { warn: (msg: string, meta?: unknown) => void };
}

export interface ApiKeyPrincipal {
  principal: string;
  scopes?: string[];
}

export type ApiKeyVerifier = (token: string) => Promise<ApiKeyPrincipal | null>;

interface CacheEntry {
  expiresAt: number;
  value: ApiKeyPrincipal | null;
}

export function makeApiKeyVerifier(opts: ApiKeyVerifierOptions): ApiKeyVerifier {
  const positiveTtl = opts.positiveTtlMs ?? 30_000;
  const negativeTtl = opts.negativeTtlMs ?? 5_000;
  const cacheMax = opts.cacheMax ?? 1024;
  const timeoutMs = opts.timeoutMs ?? 3_000;
  const doFetch = opts.fetchImpl ?? fetch;
  const warn = opts.logger?.warn ?? (() => {});

  // Insertion-ordered Map used as a simple LRU (delete + set bumps recency).
  const cache = new Map<string, CacheEntry>();

  const cacheGet = (k: string): CacheEntry | undefined => {
    const e = cache.get(k);
    if (!e) return undefined;
    if (e.expiresAt <= Date.now()) {
      cache.delete(k);
      return undefined;
    }
    cache.delete(k);
    cache.set(k, e); // bump recency
    return e;
  };

  const cacheSet = (k: string, value: ApiKeyPrincipal | null): void => {
    if (cache.size >= cacheMax) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(k, { value, expiresAt: Date.now() + (value ? positiveTtl : negativeTtl) });
  };

  return async function verify(token: string): Promise<ApiKeyPrincipal | null> {
    if (!token) return null;
    // Cache key is the hash of the token — never hold the plaintext in a
    // long-lived structure.
    const cacheKey = createHash("sha256").update(token).digest("hex");

    const cached = cacheGet(cacheKey);
    if (cached) return cached.value;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const resp = await doFetch(opts.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${opts.serviceSecret}`,
        },
        body: JSON.stringify({ key: token }),
        signal: ctrl.signal,
      });
      if (!resp.ok) {
        warn("[auth] introspection non-200", { status: resp.status });
        cacheSet(cacheKey, null); // fail-closed
        return null;
      }
      const data = (await resp.json()) as { active?: boolean; principal?: string; scopes?: string[] };
      if (!data?.active || !data.principal) {
        cacheSet(cacheKey, null);
        return null;
      }
      const value: ApiKeyPrincipal = {
        principal: data.principal,
        ...(Array.isArray(data.scopes) ? { scopes: data.scopes } : {}),
      };
      cacheSet(cacheKey, value);
      return value;
    } catch (err) {
      // Network error / timeout / abort → FAIL CLOSED. Cache negative briefly so
      // a flapping AgentOS doesn't trigger a fetch storm, but keep it short so
      // recovery is fast.
      warn("[auth] introspection error", { err: (err as Error).message });
      cacheSet(cacheKey, null);
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
}
