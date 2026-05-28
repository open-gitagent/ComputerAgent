import { useEffect, useState, type ReactNode } from "react";
import { LoginPage } from "./LoginPage.tsx";
import { Loader2 } from "lucide-react";

type State =
  | { kind: "checking" }
  | { kind: "anon" }
  | { kind: "auth"; user: string };

/**
 * Wraps the app. On mount, calls /api/me to determine whether the user is
 * already authenticated (cookie or backwards-compat Basic). If anonymous,
 * shows the LoginPage. The cookie is httpOnly so we ALWAYS round-trip to
 * the server for the truth — never trust localStorage for auth state.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>({ kind: "checking" });

  useEffect(() => {
    void check();
  }, []);

  async function check() {
    setState({ kind: "checking" });
    try {
      const res = await fetch("/api/me", { credentials: "include" });
      if (res.ok) {
        const data = (await res.json()) as { user: string };
        setState({ kind: "auth", user: data.user });
      } else {
        setState({ kind: "anon" });
      }
    } catch {
      // Backend unreachable — treat as anon so the login form gives a clear
      // error rather than spinning forever.
      setState({ kind: "anon" });
    }
  }

  if (state.kind === "checking") {
    return (
      <div className="min-h-screen grid place-items-center bg-background text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }
  if (state.kind === "anon") {
    return <LoginPage onSuccess={() => void check()} />;
  }
  return <>{children}</>;
}
