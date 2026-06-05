import { LogIn } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card.tsx";
import { Button } from "./ui/button.tsx";
import { api } from "../api.ts";

/**
 * SSO sign-in screen. A single button does a full-page redirect to the server's
 * BFF login endpoint (/api/v1/auth/login), which bounces to Keycloak → Okta and
 * returns with an httpOnly session cookie set. The browser never holds a token.
 */
export function LoginPage() {
  const signIn = () => {
    window.location.href = api.auth.loginUrl();
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      {/* Subtle ambient glow */}
      <div className="fixed inset-0 pointer-events-none opacity-40">
        <div className="absolute top-1/4 left-1/2 -translate-x-1/2 h-72 w-[600px] bg-primary/20 blur-[120px] rounded-full" />
      </div>

      <div className="w-full max-w-sm relative">
        {/* Brand */}
        <div className="flex items-center justify-center gap-3 mb-8">
          <img
            src="/logos/agentos.png"
            alt="ComputerAgent"
            className="h-10 w-10 rounded-lg object-contain ring-1 ring-border"
          />
          <div className="leading-tight">
            <div className="text-base font-semibold tracking-tight text-foreground">ComputerAgent</div>
            <div className="text-[10px] text-muted-foreground/70 font-mono uppercase tracking-widest">
              Console
            </div>
          </div>
        </div>

        <Card className="border-border/60 shadow-xl">
          <CardHeader>
            <CardTitle className="text-base">Sign in</CardTitle>
            <CardDescription className="text-xs">
              Authenticate with your organization's single sign-on.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={signIn} className="w-full gap-2">
              <LogIn className="h-4 w-4" />
              Sign in with SSO
            </Button>
          </CardContent>
        </Card>

        <p className="mt-6 text-center text-[11px] text-muted-foreground/60">
          Secured by Okta via Keycloak · session cookie set after sign-in
        </p>
      </div>
    </div>
  );
}
