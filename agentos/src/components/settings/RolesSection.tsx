/**
 * Roles settings section — the editable role→permission map. Role NAMES come
 * from Okta groups (via Keycloak, in the token); this screen defines what each
 * role is ALLOWED to do. Built-in roles (agentos-admin/editor/viewer) can have
 * their permissions edited but not deleted; custom roles can be created/removed.
 *
 * Gated to `roles:manage` by SettingsPage. Rendered inside the "Roles" tab.
 */
import { useEffect, useMemo, useState } from "react";
import { ShieldCheck, Plus, Trash2, Save } from "lucide-react";
import { toast } from "sonner";
import { api, type Role, type PermissionDef } from "../../api.ts";
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

function PermGrid({
  catalog,
  selected,
  onToggle,
  disabled,
}: {
  catalog: PermissionDef[];
  selected: Set<string>;
  onToggle: (key: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
      {catalog.map((p) => {
        const on = selected.has(p.key);
        return (
          <button
            key={p.key}
            type="button"
            disabled={disabled}
            onClick={() => onToggle(p.key)}
            title={p.description}
            className={
              "text-left rounded-md border px-2.5 py-1.5 text-xs transition-colors disabled:opacity-50 " +
              (on
                ? "border-primary/50 bg-primary/10 text-foreground"
                : "border-border bg-card text-muted-foreground hover:border-border/80")
            }
          >
            <span className="font-mono">{p.key}</span>
            <span className="block text-[10px] text-muted-foreground/70 truncate">{p.description}</span>
          </button>
        );
      })}
    </div>
  );
}

function RoleEditor({ role, catalog, onSaved }: { role: Role; catalog: PermissionDef[]; onSaved: () => void }) {
  const wildcard = role.permissions.includes("*");
  const [selected, setSelected] = useState<Set<string>>(new Set(role.permissions));
  const [description, setDescription] = useState(role.description);
  const [saving, setSaving] = useState(false);

  const toggle = (key: string) =>
    setSelected((s) => {
      const next = new Set(s);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });

  const save = async () => {
    setSaving(true);
    try {
      await api.roles.update(role._id, { description, permissions: [...selected] });
      toast.success(`Saved “${role._id}”.`);
      onSaved();
    } catch (e) {
      toast.error(`Save failed: ${String(e)}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3 pt-3">
      <div>
        <Label className="text-xs text-muted-foreground">Description</Label>
        <Input value={description} onChange={(e) => setDescription(e.target.value)} />
      </div>
      {wildcard ? (
        <div className="text-xs text-muted-foreground rounded-md border border-border bg-muted/30 px-3 py-2">
          This role grants <span className="font-mono">*</span> (full access). Edit the permission list to scope it down.
        </div>
      ) : null}
      <PermGrid catalog={catalog} selected={selected} onToggle={toggle} />
      <div className="flex justify-end">
        <Button size="sm" onClick={save} disabled={saving} className="gap-1.5">
          <Save className="h-3.5 w-3.5" /> {saving ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  );
}

export function RolesSection() {
  const [roles, setRoles] = useState<Role[]>([]);
  const [catalog, setCatalog] = useState<PermissionDef[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Role | null>(null);

  // Create form
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);

  const load = () => {
    setLoading(true);
    setErr(null);
    Promise.all([api.roles.list(), api.roles.permissions()])
      .then(([r, c]) => {
        setRoles(r);
        setCatalog(c);
      })
      .catch((e) => setErr(String(e)))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  const createRole = async () => {
    const name = newName.trim();
    if (!name) {
      toast.error("Give the role a name (must match the Keycloak role name).");
      return;
    }
    setCreating(true);
    try {
      await api.roles.create({ name, permissions: [] });
      toast.success(`Created “${name}”.`);
      setNewName("");
      setExpanded(name);
      load();
    } catch (e) {
      toast.error(`Create failed: ${String(e)}`);
    } finally {
      setCreating(false);
    }
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    try {
      await api.roles.remove(pendingDelete._id);
      toast.success(`Deleted “${pendingDelete._id}”.`);
      setPendingDelete(null);
      load();
    } catch (e) {
      toast.error(`Delete failed: ${String(e)}`);
    }
  };

  const sorted = useMemo(() => [...roles].sort((a, b) => a._id.localeCompare(b._id)), [roles]);

  return (
    <div className="space-y-6">
      <p className="text-xs text-muted-foreground max-w-2xl">
        Roles map a Keycloak role name (assigned via Okta group membership) to a set of permissions. Okta decides{" "}
        <em>who</em> has a role; this screen decides what the role <em>can do</em>. A new Okta group needs its
        permissions defined here once.
      </p>

      {/* Create */}
      <div className="rounded-lg border border-border bg-card p-4">
        <div className="text-sm font-semibold mb-3 flex items-center gap-2">
          <Plus className="h-4 w-4" /> Add a role
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex-1 min-w-[220px]">
            <Label htmlFor="role-name" className="text-xs text-muted-foreground">
              Role name (matches Keycloak)
            </Label>
            <Input
              id="role-name"
              placeholder="e.g. agentos-ops"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && createRole()}
            />
          </div>
          <Button onClick={createRole} disabled={creating}>
            {creating ? "Creating…" : "Create role"}
          </Button>
        </div>
      </div>

      {/* List */}
      <div className="rounded-lg border border-border bg-card">
        <div className="px-4 py-3 border-b border-border text-sm font-semibold">
          Roles {roles.length > 0 && <span className="text-muted-foreground font-normal">· {roles.length}</span>}
        </div>
        {err && <div className="px-4 py-3 text-sm text-destructive">{err}</div>}
        {loading ? (
          <div className="px-4 py-6 text-sm text-muted-foreground">Loading…</div>
        ) : (
          <div className="divide-y divide-border">
            {sorted.map((r) => (
              <div key={r._id} className="px-4 py-3">
                <div className="flex items-center gap-3">
                  <ShieldCheck className="h-4 w-4 text-muted-foreground" />
                  <button
                    type="button"
                    className="min-w-0 flex-1 text-left"
                    onClick={() => setExpanded((e) => (e === r._id ? null : r._id))}
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium font-mono">{r._id}</span>
                      {r.builtin && <Badge variant="secondary">built-in</Badge>}
                      <span className="text-[11px] text-muted-foreground">
                        {r.permissions.includes("*") ? "full access" : `${r.permissions.length} permission(s)`}
                      </span>
                    </div>
                    {r.description && <div className="mt-0.5 text-[11px] text-muted-foreground">{r.description}</div>}
                  </button>
                  {!r.builtin && (
                    <Button variant="ghost" size="icon" title="Delete role" onClick={() => setPendingDelete(r)}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  )}
                </div>
                {expanded === r._id && <RoleEditor role={r} catalog={catalog} onSaved={load} />}
              </div>
            ))}
          </div>
        )}
      </div>

      <AlertDialog open={!!pendingDelete} onOpenChange={(o) => !o && setPendingDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this role?</AlertDialogTitle>
            <AlertDialogDescription>
              “{pendingDelete?._id}” will be removed. Users/keys that reference it will resolve to no permissions for
              this role. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDelete}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
