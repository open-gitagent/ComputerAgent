// Centralized auth-aware fetch — the SPA's "interceptor" for the BFF session.
//
// The session cookie is short-lived (it tracks the Keycloak access-token expiry,
// ~5 min). When ANY request 401s we silently POST /auth/refresh — which rotates
// the server-held refresh token and re-signs the cookie — then replay the
// request once. All concurrent 401s share ONE in-flight refresh: refresh tokens
// rotate and can be spent only once, so a stampede would invalidate itself.
// On a hard refresh failure the session is truly gone → notify AuthContext
// (which flips to the SSO sign-in screen).
//
// Every network surface routes through here: the dashboard client (api.ts), the
// observability reads (obs-api.ts), and the SSE streams (sse.ts). `authedFetch`
// takes a FULL url (not a prefix) so each caller keeps its own base.

let refreshInFlight: Promise<boolean> | null = null;
let onAuthLost: (() => void) | null = null;

/** AuthContext registers a callback here to flip to the anonymous/login state
 *  when the refresh token is dead (idle timeout / revocation / logout). */
export function setAuthLostHandler(fn: (() => void) | null): void {
  onAuthLost = fn;
}

/** Single-flight refresh. Returns true if the session was renewed. */
export function refreshOnce(): Promise<boolean> {
  if (!refreshInFlight) {
    refreshInFlight = fetch(`/api/v1/auth/refresh`, {
      method: "POST",
      headers: { accept: "application/json" },
      credentials: "include",
    })
      .then((r) => r.ok)
      .catch(() => false)
      .finally(() => {
        refreshInFlight = null;
      });
  }
  return refreshInFlight;
}

/** fetch with credentials. On 401: refresh once and replay; if refresh fails,
 *  signal auth-lost and return the (final) 401 response to the caller. */
export async function authedFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const opts: RequestInit = { credentials: "include", ...init };
  let r = await fetch(url, opts);
  if (r.status === 401) {
    const ok = await refreshOnce();
    if (ok) {
      r = await fetch(url, opts);
    } else {
      onAuthLost?.();
    }
  }
  return r;
}
