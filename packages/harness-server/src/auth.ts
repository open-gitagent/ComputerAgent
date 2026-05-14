/**
 * Pluggable authentication hook. When configured, every /v1/* request is
 * routed through `authenticate()` first. Returning null/undefined produces
 * 401 UNAUTHORIZED; returning a context object lets the request proceed.
 *
 * The framework is deliberately unopinionated about *how* you authenticate —
 * `bearerToken` is shipped as a convenience for the most common case (single
 * shared secret, or a lookup table). For more complex schemes (JWT, mTLS,
 * OAuth), provide your own implementation.
 *
 * No-auth (the default) is appropriate for loopback-only deployments — same
 * machine, no untrusted code paths. Any remote substrate (E2B, VZVM exposed
 * across a network) MUST set an auth handler.
 */
export interface AuthContext {
  readonly principal: string;
  readonly scopes?: readonly string[];
}

export interface AuthRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Headers;
}

export interface AuthHandler {
  authenticate(req: AuthRequest): Promise<AuthContext | null> | AuthContext | null;
}

/** Bearer-token handler: matches `Authorization: Bearer <token>` against a verifier. */
export function bearerToken(verify: (token: string) => AuthContext | null | Promise<AuthContext | null>): AuthHandler {
  return {
    async authenticate(req) {
      const header = req.headers.get("authorization") ?? req.headers.get("Authorization");
      if (!header) return null;
      const match = /^Bearer\s+(.+)$/i.exec(header);
      if (!match) return null;
      return verify(match[1]!);
    },
  };
}

/** Bearer-token handler with a simple shared-secret check. */
export function sharedSecretAuth(token: string, principal: string = "shared-secret"): AuthHandler {
  return bearerToken((t) => (t === token ? { principal } : null));
}
