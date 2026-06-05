/**
 * API Keys settings section — mint, list, and revoke the workspace API keys the
 * ComputerAgent server accepts (`Authorization: Bearer cak_…`). Keys are stored
 * hashed server-side; the plaintext is shown exactly ONCE, in a modal right
 * after creation. After that only `prefix•••last4` is ever displayed.
 *
 * Rendered inside SettingsPage's "API Keys" tab — it owns no page header.
 */
import { useEffect, useState } from "react";
import { KeyRound, Copy, Check, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api, type ApiKey } from "../../api.ts";
import { useAuth } from "../../context/AuthContext.tsx";
import { useAssignableGroups } from "../../hooks/useAssignableGroups.ts";
import { Button } from "../ui/button.tsx";
import { Input } from "../ui/input.tsx";
import { Label } from "../ui/label.tsx";
import { Badge } from "../ui/badge.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog.tsx";
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

export function ApiKeysSection() {
  const { me, can } = useAuth();
  // The tab is visible to keys:read; minting/revoking needs keys:manage.
  const canManage = can("keys:manage");
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  // Create form
  const [label, setLabel] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  // CAPABILITY (roles) + TENANCY (group) — kept separate. A key gets the roles
  // you grant it (bounded by your own, unless admin) and belongs to one group.
  const [selectedRoles, setSelectedRoles] = useState<string[]>([]);
  const [selectedGroup, setSelectedGroup] = useState("");
  const [allRoles, setAllRoles] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);

  // Admins may grant any role; everyone else only the roles they hold.
  useEffect(() => {
    if (can("roles:manage")) {
      api.roles
        .list()
        .then((rs) => setAllRoles(rs.map((r) => r._id)))
        .catch(() => {});
    }
  }, [can]);
  const roleChoices = can("roles:manage") ? allRoles : me?.roles ?? [];
  const groupChoices = useAssignableGroups();
  const toggleRole = (r: string) =>
    setSelectedRoles((s) => (s.includes(r) ? s.filter((x) => x !== r) : [...s, r]));

  // One-time reveal of a freshly minted key
  const [revealed, setRevealed] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Revoke confirmation
  const [pendingRevoke, setPendingRevoke] = useState<ApiKey | null>(null);

  const load = () => {
    setLoading(true);
    setErr(null);
    api.apiKeys
      .list()
      .then(setKeys)
      .catch((e) => setErr(String(e)))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  const create = async () => {
    if (!label.trim()) {
      toast.error("Give the key a label.");
      return;
    }
    if (selectedRoles.length === 0) {
      toast.error("Pick at least one role (what the key can do).");
      return;
    }
    setCreating(true);
    try {
      const res = await api.apiKeys.create(label.trim(), {
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
        roleIds: selectedRoles,
        group: selectedGroup || undefined,
      });
      setRevealed(res.key);
      setCopied(false);
      setLabel("");
      setExpiresAt("");
      setSelectedRoles([]);
      setSelectedGroup("");
      load();
    } catch (e) {
      toast.error(`Create failed: ${String(e)}`);
    } finally {
      setCreating(false);
    }
  };

  const copyKey = async () => {
    if (!revealed) return;
    try {
      await navigator.clipboard.writeText(revealed);
      setCopied(true);
      toast.success("Copied to clipboard.");
    } catch {
      toast.error("Copy failed — select and copy manually.");
    }
  };

  const confirmRevoke = async () => {
    if (!pendingRevoke) return;
    try {
      await api.apiKeys.revoke(pendingRevoke._id);
      toast.success(`Revoked “${pendingRevoke.label}”.`);
      setPendingRevoke(null);
      load();
    } catch (e) {
      toast.error(`Revoke failed: ${String(e)}`);
    }
  };

  const isExpired = (k: ApiKey) => !!k.expiresAt && new Date(k.expiresAt).getTime() <= Date.now();

  return (
    <div className="space-y-6">
      <p className="text-xs text-muted-foreground max-w-2xl">
        Keys the ComputerAgent server accepts as Bearer tokens. Pass one to the SDK via{" "}
        <code className="font-mono">harness_token=</code> or the{" "}
        <code className="font-mono">COMPUTERAGENT_HARNESS_TOKEN</code> env var. Keys are stored hashed and shown only once.
      </p>

      {/* Create — only for users who can manage keys (keys:manage). */}
      {canManage && (
      <div className="rounded-lg border border-border bg-card p-4">
        <div className="text-sm font-semibold mb-3 flex items-center gap-2">
          <KeyRound className="h-4 w-4" /> Create a key
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex-1 min-w-[200px]">
            <Label htmlFor="ak-label" className="text-xs text-muted-foreground">Label</Label>
            <Input
              id="ak-label"
              placeholder="e.g. qa-worker prod"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && create()}
            />
          </div>
          <div className="min-w-[160px]">
            <Label htmlFor="ak-group" className="text-xs text-muted-foreground">Group (optional)</Label>
            <select
              id="ak-group"
              value={selectedGroup}
              onChange={(e) => setSelectedGroup(e.target.value)}
              className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
            >
              <option value="">No group</option>
              {groupChoices.map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </select>
          </div>
          <div className="min-w-[160px]">
            <Label htmlFor="ak-exp" className="text-xs text-muted-foreground">Expires (optional)</Label>
            <Input id="ak-exp" type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
          </div>
          <Button onClick={create} disabled={creating}>
            {creating ? "Creating…" : "Create key"}
          </Button>
        </div>

        {/* Capability — roles the key acts with (what it can DO). */}
        <div className="mt-3">
          <Label className="text-xs text-muted-foreground">Roles (what the key can do)</Label>
          {roleChoices.length === 0 ? (
            <p className="mt-1 text-[11px] text-muted-foreground/70">
              You hold no roles to grant. Ask an admin, or sign in with a role assigned.
            </p>
          ) : (
            <div className="mt-1 flex flex-wrap gap-1.5">
              {roleChoices.map((r) => {
                const on = selectedRoles.includes(r);
                return (
                  <button
                    key={r}
                    type="button"
                    onClick={() => toggleRole(r)}
                    className={
                      "rounded-md border px-2.5 py-1 text-xs font-mono transition-colors " +
                      (on
                        ? "border-primary/50 bg-primary/10 text-foreground"
                        : "border-border bg-card text-muted-foreground hover:border-border/80")
                    }
                  >
                    {r}
                  </button>
                );
              })}
            </div>
          )}
          <p className="mt-1.5 text-[10px] text-muted-foreground/70">
            Permissions come from the selected roles. The group scopes what the key can see (ownership).
          </p>
        </div>
      </div>
      )}

      {/* List */}
      <div className="rounded-lg border border-border bg-card">
        <div className="px-4 py-3 border-b border-border text-sm font-semibold">
          Keys {keys.length > 0 && <span className="text-muted-foreground font-normal">· {keys.length}</span>}
        </div>
        {err && <div className="px-4 py-3 text-sm text-destructive">{err}</div>}
        {loading ? (
          <div className="px-4 py-6 text-sm text-muted-foreground">Loading…</div>
        ) : keys.length === 0 ? (
          <div className="px-4 py-6 text-sm text-muted-foreground">No keys yet.{canManage ? " Create one above." : ""}</div>
        ) : (
          <div className="divide-y divide-border">
            {keys.map((k) => {
              const dead = k.revoked || isExpired(k);
              return (
                <div key={k._id} className="flex items-center gap-4 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className={"text-sm font-medium truncate " + (dead ? "text-muted-foreground line-through" : "")}>
                        {k.label}
                      </span>
                      {k.group && <Badge variant="outline">group: {k.group}</Badge>}
                      {(k.roleIds ?? []).map((r) => (
                        <Badge key={r} variant="secondary">{r}</Badge>
                      ))}
                      {k.revoked && <Badge variant="destructive">revoked</Badge>}
                      {!k.revoked && isExpired(k) && <Badge variant="secondary">expired</Badge>}
                    </div>
                    <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">
                      {k.prefix}•••{k.last4}
                    </div>
                  </div>
                  <div className="hidden md:block text-right text-[11px] text-muted-foreground leading-relaxed">
                    <div>created {fmt(k.createdAt)} · by {k.createdBy}</div>
                    <div>
                      {k.expiresAt ? `expires ${fmt(k.expiresAt)}` : "no expiry"} · last used {fmt(k.lastUsedAt)}
                    </div>
                  </div>
                  {canManage && (
                    <Button
                      variant="ghost"
                      size="icon"
                      disabled={k.revoked}
                      title={k.revoked ? "Already revoked" : "Revoke"}
                      onClick={() => setPendingRevoke(k)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* One-time reveal modal */}
      <Dialog open={!!revealed} onOpenChange={(o) => !o && setRevealed(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Copy your API key now</DialogTitle>
            <DialogDescription>
              This is the only time the key is shown. Store it somewhere safe — you won't be able to see it again.
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2">
            <code className="flex-1 break-all font-mono text-xs">{revealed}</code>
            <Button variant="outline" size="icon" onClick={copyKey} title="Copy">
              {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            </Button>
          </div>
          <DialogFooter>
            <Button onClick={() => setRevealed(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Revoke confirmation */}
      <AlertDialog open={!!pendingRevoke} onOpenChange={(o) => !o && setPendingRevoke(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke this key?</AlertDialogTitle>
            <AlertDialogDescription>
              “{pendingRevoke?.label}” ({pendingRevoke?.prefix}•••{pendingRevoke?.last4}) will stop working within
              ~30 seconds. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmRevoke}>Revoke</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
