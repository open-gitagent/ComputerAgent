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
  /**
   * Effective permission keys resolved from the key's roles by AgentOS (e.g.
   * `["agents:run", "agents:read", ...]` or `["*"]` for admin). Gated per route
   * by {@link requiredPermissionFor} + {@link principalHasPermission}.
   *
   * `undefined` means the introspection response carried NO `permissions` field
   * — an AgentOS that predates capability resolution. The gate treats that as a
   * back-compat "active ⇒ allow" to avoid breaking a rolling upgrade; as soon as
   * AgentOS returns `permissions` (even `[]`), enforcement kicks in.
   */
  permissions?: string[];
  /** The key's bound group (tenancy), if any. Captured for audit/identity. */
  group?: string | null;
  /** @deprecated Always `["*"]` from AgentOS; retained for back-compat only. */
  scopes?: string[];
}

/** Permission catalog keys the CAS gates on (subset of AgentOS's catalog). */
const PERM_AGENTS_RUN = "agents:run";
const PERM_AGENTS_READ = "agents:read";
const WILDCARD = "*";

/**
 * Map an inbound CAS request to the permission it requires. The CAS surface is
 * small and uniform: reads (GET) need `agents:read`; everything that executes or
 * mutates an agent/sandbox/task (POST/DELETE on /run, /sandboxes, /tasks, …)
 * needs `agents:run`. `/health` + `/slack/*` are unauthenticated and never reach
 * here. Returns null when no permission is required.
 */
export function requiredPermissionFor(method: string, _path: string): string | null {
  return method.toUpperCase() === "GET" ? PERM_AGENTS_READ : PERM_AGENTS_RUN;
}

/**
 * Capability check for a verified key. `["*"]` satisfies anything. A principal
 * with NO `permissions` field (old AgentOS) is allowed for back-compat (see
 * {@link ApiKeyPrincipal.permissions}); the caller logs that case once.
 */
export function principalHasPermission(p: ApiKeyPrincipal, perm: string | null): boolean {
  if (perm === null) return true;
  if (p.permissions === undefined) return true; // back-compat: pre-capability AgentOS
  return p.permissions.includes(WILDCARD) || p.permissions.includes(perm);
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
      const data = (await resp.json()) as {
        active?: boolean;
        principal?: string;
        permissions?: string[];
        group?: string | null;
        scopes?: string[];
      };
      if (!data?.active || !data.principal) {
        cacheSet(cacheKey, null);
        return null;
      }
      const value: ApiKeyPrincipal = {
        principal: data.principal,
        // Preserve `undefined` (field absent) vs `[]` (present, no perms) — the
        // gate distinguishes them for the rolling-upgrade back-compat path.
        ...(Array.isArray(data.permissions) ? { permissions: data.permissions } : {}),
        ...(typeof data.group === "string" ? { group: data.group } : {}),
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
