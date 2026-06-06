/**
 * Git Credentials settings section — store the PATs the ComputerAgent SDK uses
 * to clone PRIVATE GAP repos. A credential is owned by a GROUP (team) and scoped
 * to one HOST (one PAT per group+host). The secret is encrypted server-side and
 * is WRITE-ONLY — never shown again after you save it (you already hold the PAT).
 *
 * Rendered inside SettingsPage's "Git Credentials" tab. Gated by
 * `git-credentials:read` (tab) / `git-credentials:manage` (create+delete).
 */
import { useEffect, useState } from "react";
import { KeyRound, Trash2, GitBranch } from "lucide-react";
import { toast } from "sonner";
import { api, type GitCredential } from "../../api.ts";
import { useAuth } from "../../context/AuthContext.tsx";
import { useAssignableGroups } from "../../hooks/useAssignableGroups.ts";
import { Button } from "../ui/button.tsx";
import { Input } from "../ui/input.tsx";
import { Label } from "../ui/label.tsx";
import { Badge } from "../ui/badge.tsx";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../ui/alert-dialog.tsx";

function fmt(d?: string | null): string {
  if (!d) return "—";
  const t = new Date(d);
  return Number.isNaN(t.getTime()) ? "—" : t.toLocaleString();
}

export function GitCredentialsSection() {
  const { can } = useAuth();
  const canManage = can("git-credentials:manage");
  const [creds, setCreds] = useState<GitCredential[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  // Create form
  const [host, setHost] = useState("github.com");
  const [label, setLabel] = useState("");
  const [token, setToken] = useState("");
  const [username, setUsername] = useState("");
  const [group, setGroup] = useState("");
  const [creating, setCreating] = useState(false);

  const groupChoices = useAssignableGroups();
  useEffect(() => {
    if (!group && groupChoices.length) setGroup(groupChoices[0]!);
  }, [groupChoices, group]);

  const [pendingDelete, setPendingDelete] = useState<GitCredential | null>(null);

  const load = () => {
    setLoading(true);
    setErr(null);
    api.gitCredentials
      .list()
      .then(setCreds)
      .catch((e) => setErr(String(e)))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  const create = async () => {
    if (!host.trim()) return toast.error("Host is required (e.g. github.com).");
    if (!label.trim()) return toast.error("Give the credential a label.");
    if (!token.trim()) return toast.error("Paste the PAT.");
    if (!group) return toast.error("Pick the owning group.");
    setCreating(true);
    try {
      await api.gitCredentials.create({
        host: host.trim(),
        label: label.trim(),
        token: token.trim(),
        group,
        ...(username.trim() ? { username: username.trim() } : {}),
      });
      toast.success("Credential saved.");
      setLabel("");
      setToken("");
      setUsername("");
      load();
    } catch (e) {
      toast.error(`Save failed: ${String(e)}`);
    } finally {
      setCreating(false);
    }
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    try {
      await api.gitCredentials.remove(pendingDelete._id);
      toast.success(`Deleted "${pendingDelete.label}".`);
      setPendingDelete(null);
      load();
    } catch (e) {
      toast.error(`Delete failed: ${String(e)}`);
    }
  };

  return (
    <div className="space-y-6">
      <p className="max-w-2xl text-xs text-muted-foreground">
        Personal access tokens the SDK uses to clone <span className="font-medium">private</span> GAP repos. A
        credential is owned by a group and scoped to one host — one PAT per group per host. Tokens are encrypted at
        rest and <span className="font-medium">never shown again</span> after you save them; saving again for the same
        group + host rotates the token.
      </p>

      {/* Create — only for managers. */}
      {canManage && (
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
            <KeyRound className="h-4 w-4" /> Add a credential
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-[160px]">
              <Label htmlFor="gc-host" className="text-xs text-muted-foreground">Host</Label>
              <Input id="gc-host" placeholder="github.com" value={host} onChange={(e) => setHost(e.target.value)} />
            </div>
            <div className="min-w-[160px]">
              <Label htmlFor="gc-group" className="text-xs text-muted-foreground">Group (owner)</Label>
              <select
                id="gc-group"
                value={group}
                onChange={(e) => setGroup(e.target.value)}
                className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
              >
                {groupChoices.length === 0 && <option value="">No groups</option>}
                {groupChoices.map((g) => (
                  <option key={g} value={g}>{g}</option>
                ))}
              </select>
            </div>
            <div className="min-w-[160px] flex-1">
              <Label htmlFor="gc-label" className="text-xs text-muted-foreground">Label</Label>
              <Input id="gc-label" placeholder="e.g. platform private repos" value={label} onChange={(e) => setLabel(e.target.value)} />
            </div>
          </div>
          <div className="mt-3 flex flex-wrap items-end gap-3">
            <div className="min-w-[260px] flex-1">
              <Label htmlFor="gc-token" className="text-xs text-muted-foreground">Token (PAT)</Label>
              <Input id="gc-token" type="password" placeholder="ghp_… / github_pat_…" value={token} onChange={(e) => setToken(e.target.value)} />
            </div>
            <div className="min-w-[160px]">
              <Label htmlFor="gc-username" className="text-xs text-muted-foreground">Username (optional)</Label>
              <Input id="gc-username" placeholder="x-access-token" value={username} onChange={(e) => setUsername(e.target.value)} />
            </div>
            <Button onClick={create} disabled={creating}>
              {creating ? "Saving…" : "Save credential"}
            </Button>
          </div>
          <p className="mt-2 text-[10px] text-muted-foreground/70">
            GitHub fine-grained/classic tokens use the default <span className="font-mono">x-access-token</span> username;
            GitLab uses <span className="font-mono">oauth2</span>, Bitbucket your username.
          </p>
        </div>
      )}

      {/* List */}
      <div className="rounded-lg border border-border bg-card">
        <div className="border-b border-border px-4 py-3 text-sm font-semibold">
          Credentials {creds.length > 0 && <span className="font-normal text-muted-foreground">· {creds.length}</span>}
        </div>
        {err && <div className="px-4 py-3 text-sm text-destructive">{err}</div>}
        {loading ? (
          <div className="px-4 py-6 text-sm text-muted-foreground">Loading…</div>
        ) : creds.length === 0 ? (
          <div className="px-4 py-6 text-sm text-muted-foreground">No credentials yet.{canManage ? " Add one above." : ""}</div>
        ) : (
          <div className="divide-y divide-border">
            {creds.map((c) => (
              <div key={c._id} className="flex items-center gap-4 px-4 py-3">
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
                  <GitBranch className="h-4 w-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{c.label}</span>
                    <Badge variant="outline" className="font-mono text-[10px]">{c.host}</Badge>
                    <Badge variant="secondary" className="text-[10px]">group: {c.ownerGroup}</Badge>
                  </div>
                  <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">
                    {c.username || "x-access-token"} · •••{c.last4}
                  </div>
                </div>
                <div className="hidden text-right text-[11px] leading-relaxed text-muted-foreground md:block">
                  <div>added {fmt(c.createdAt)} · by {c.createdBy}</div>
                  <div>{c.rotatedAt ? `rotated ${fmt(c.rotatedAt)}` : `updated ${fmt(c.updatedAt)}`}</div>
                </div>
                {canManage && (
                  <Button variant="ghost" size="icon" title="Delete" onClick={() => setPendingDelete(c)}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <AlertDialog open={!!pendingDelete} onOpenChange={(o) => !o && setPendingDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete credential?</AlertDialogTitle>
            <AlertDialogDescription>
              Removes the <span className="font-mono">{pendingDelete?.host}</span> token for group{" "}
              <span className="font-mono">{pendingDelete?.ownerGroup}</span>. Agents that clone private repos on this
              host will fail to authenticate until a new credential is added.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDelete} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
