import { useState, type FormEvent } from "react";
import { Loader2, LogIn } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card.tsx";
import { Input } from "./ui/input.tsx";
import { Button } from "./ui/button.tsx";
import { Label } from "./ui/label.tsx";

/**
 * Polished login screen. Posts {user, pass} to /api/login which sets an
 * httpOnly session cookie; on success calls `onSuccess` so the AuthGate
 * can rerender the protected app.
 *
 * The dashboard's auth is intentionally simple — one shared credential,
 * cookie session — so this is a single Card with two fields. No password
 * reset, no SSO. The customer's internal Ingress (Caddy basic_auth in
 * earlier shape; nothing extra in the cookie shape) is the real boundary.
 */
export function LoginPage({ onSuccess }: { onSuccess: (user: string) => void }) {
  const [user, setUser] = useState("");
  const [pass, setPass] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!user || !pass) {
      setError("Enter both fields.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ user, pass }),
        credentials: "include",
      });
      if (res.status === 401) {
        setError("Invalid credentials.");
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body?.error?.code ?? `Login failed (HTTP ${res.status}).`);
        return;
      }
      const data = (await res.json()) as { ok: boolean; user: string };
      onSuccess(data.user);
    } catch (err) {
      setError(String(err));
    } finally {
      setSubmitting(false);
    }
  }

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
            <div className="text-base font-semibold tracking-tight">ComputerAgent</div>
            <div className="text-[10px] text-muted-foreground/70 font-mono uppercase tracking-widest">
              Console
            </div>
          </div>
        </div>

        <Card className="border-border/60 shadow-xl">
          <CardHeader>
            <CardTitle className="text-base">Sign in</CardTitle>
            <CardDescription className="text-xs">
              Enter the operator credentials to access the registry.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={onSubmit} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="user" className="text-xs uppercase tracking-wide text-muted-foreground">
                  User
                </Label>
                <Input
                  id="user"
                  type="text"
                  autoComplete="username"
                  value={user}
                  onChange={(e) => setUser(e.target.value)}
                  disabled={submitting}
                  autoFocus
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="pass" className="text-xs uppercase tracking-wide text-muted-foreground">
                  Password
                </Label>
                <Input
                  id="pass"
                  type="password"
                  autoComplete="current-password"
                  value={pass}
                  onChange={(e) => setPass(e.target.value)}
                  disabled={submitting}
                />
              </div>

              {error && (
                <div className="text-xs text-destructive bg-destructive/10 border border-destructive/20 rounded-md px-3 py-2">
                  {error}
                </div>
              )}

              <Button type="submit" disabled={submitting} className="w-full gap-2">
                {submitting ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Signing in…
                  </>
                ) : (
                  <>
                    <LogIn className="h-4 w-4" />
                    Sign in
                  </>
                )}
              </Button>
            </form>
          </CardContent>
        </Card>

        <p className="mt-6 text-center text-[11px] text-muted-foreground/60">
          Session lasts 7 days · cookie-based · cleared with{" "}
          <code className="font-mono">/api/logout</code>
        </p>
      </div>
    </div>
  );
}
