import { type ReactNode } from "react";
import { LoginPage } from "./LoginPage.tsx";
import { useAuth } from "../context/AuthContext.tsx";
import { Loader2 } from "lucide-react";

/**
 * Gates the app on the auth state from AuthContext (GET /me). While checking,
 * shows a spinner; anonymous → the SSO sign-in screen; authenticated → the app.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const { state } = useAuth();

  if (state.kind === "checking") {
    return (
      <div className="min-h-screen grid place-items-center bg-background text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }
  if (state.kind === "anon") {
    return <LoginPage />;
  }
  return <>{children}</>;
}
