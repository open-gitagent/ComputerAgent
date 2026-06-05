// Auth state for the SPA. Fetches GET /me once on mount (the BFF session cookie
// is httpOnly, so the server is the source of truth — never localStorage).
// Exposes the principal + a `can(permission)` helper for UI gating. The server's
// authorize() is the real boundary; this only hides controls the user can't use.

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, setAuthLostHandler, type Me } from "../api.ts";

type State = { kind: "checking" } | { kind: "anon" } | { kind: "auth"; me: Me };

interface AuthValue {
  state: State;
  me: Me | null;
  can: (perm: string) => boolean;
  /** True if the principal may mutate/delete a resource: admin, or its owner. */
  owns: (r: { ownerUser?: string | null }) => boolean;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
}

const AuthCtx = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>({ kind: "checking" });

  const refresh = useCallback(async () => {
    setState({ kind: "checking" });
    try {
      const me = await api.auth.me();
      setState({ kind: "auth", me });
    } catch {
      // 401 / unreachable → anonymous; LoginPage offers the SSO redirect.
      setState({ kind: "anon" });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // When a silent token refresh fails mid-session (idle timeout / revocation),
  // the api layer calls this — drop to anonymous so the SSO sign-in shows.
  useEffect(() => {
    setAuthLostHandler(() => setState({ kind: "anon" }));
    return () => setAuthLostHandler(null);
  }, []);

  const me = state.kind === "auth" ? state.me : null;

  const can = useCallback(
    (perm: string) => !!me && (me.permissions.includes("*") || me.permissions.includes(perm)),
    [me],
  );

  const owns = useCallback(
    (r: { ownerUser?: string | null }) =>
      !!me && (me.permissions.includes("*") || (!!r.ownerUser && r.ownerUser === me.id)),
    [me],
  );

  const logout = useCallback(async () => {
    try {
      const r = await api.auth.logout();
      if (r.logoutUrl) {
        window.location.href = r.logoutUrl; // also end the Keycloak SSO session
        return;
      }
    } catch {
      /* fall through to refresh */
    }
    await refresh();
  }, [refresh]);

  const value = useMemo<AuthValue>(
    () => ({ state, me, can, owns, refresh, logout }),
    [state, me, can, owns, refresh, logout],
  );
  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}

export function useAuth(): AuthValue {
  const v = useContext(AuthCtx);
  if (!v) throw new Error("useAuth must be used within <AuthProvider>");
  return v;
}
