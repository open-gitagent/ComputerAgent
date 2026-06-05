/**
 * Groups settings section — READ-ONLY. Groups and their membership are owned by
 * Okta/Keycloak; AgentOS only displays them (it never creates them). Expanding a
 * group shows its members and each member's roles — which makes the key point
 * visible: one group can contain users with different roles.
 *
 * Gated to `groups:read` by SettingsPage. Degrades to a clear message when the
 * Keycloak admin client isn't configured (the read endpoint returns 503).
 */
import { useEffect, useState } from "react";
import { Users2, ChevronRight, ChevronDown } from "lucide-react";
import { api, type Group, type GroupMember } from "../../api.ts";
import { Badge } from "../ui/badge.tsx";

type MembersState = "loading" | "error" | { list: GroupMember[]; truncated: boolean };

export function GroupsSection() {
  const [groups, setGroups] = useState<Group[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [members, setMembers] = useState<Record<string, MembersState>>({});

  useEffect(() => {
    setLoading(true);
    setErr(null);
    api.groups
      .list()
      .then(setGroups)
      .catch((e) => setErr(String(e)))
      .finally(() => setLoading(false));
  }, []);

  const toggle = async (id: string) => {
    if (expanded === id) {
      setExpanded(null);
      return;
    }
    setExpanded(id);
    if (!members[id]) {
      setMembers((m) => ({ ...m, [id]: "loading" }));
      try {
        const res = await api.groups.members(id);
        setMembers((m) => ({ ...m, [id]: { list: res.members, truncated: res.truncated } }));
      } catch {
        setMembers((m) => ({ ...m, [id]: "error" }));
      }
    }
  };

  return (
    <div className="space-y-6">
      <p className="text-xs text-muted-foreground max-w-2xl">
        Groups and membership are managed in <strong>Okta / Keycloak</strong> — this view is read-only. A user's{" "}
        <em>group</em> (team) and <em>roles</em> (capability) are independent, so one group can contain members with
        different roles. To create or change groups, use the Keycloak console.
      </p>

      <div className="rounded-lg border border-border bg-card">
        <div className="px-4 py-3 border-b border-border text-sm font-semibold">
          Groups {groups.length > 0 && <span className="text-muted-foreground font-normal">· {groups.length}</span>}
        </div>

        {loading ? (
          <div className="px-4 py-6 text-sm text-muted-foreground">Loading…</div>
        ) : err ? (
          <div className="px-4 py-6 text-sm">
            <div className="text-destructive">Groups unavailable.</div>
            <div className="mt-1 text-xs text-muted-foreground">
              The Keycloak admin client isn't configured (or lacks <code className="font-mono">view-realm</code>). Set{" "}
              <code className="font-mono">KEYCLOAK_ADMIN_CLIENT_ID/SECRET</code> and enable its service account in
              Keycloak.
            </div>
          </div>
        ) : groups.length === 0 ? (
          <div className="px-4 py-6 text-sm text-muted-foreground">No groups in this realm.</div>
        ) : (
          <div className="divide-y divide-border">
            {groups.map((g) => {
              const open = expanded === g.id;
              const ms = members[g.id];
              return (
                <div key={g.id} className="px-4 py-3">
                  <button type="button" className="flex w-full items-center gap-3 text-left" onClick={() => toggle(g.id)}>
                    {open ? (
                      <ChevronDown className="h-4 w-4 text-muted-foreground" />
                    ) : (
                      <ChevronRight className="h-4 w-4 text-muted-foreground" />
                    )}
                    <Users2 className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm font-medium">{g.name}</span>
                    <span className="font-mono text-[11px] text-muted-foreground">{g.path}</span>
                  </button>

                  {open && (
                    <div className="mt-3 pl-7">
                      {ms === "loading" ? (
                        <div className="text-xs text-muted-foreground">Loading members…</div>
                      ) : ms === "error" ? (
                        <div className="text-xs text-destructive">Couldn't load members (needs view-users).</div>
                      ) : !ms || ms.list.length === 0 ? (
                        <div className="text-xs text-muted-foreground">No members.</div>
                      ) : (
                        <div className="space-y-1.5">
                          {ms.list.map((mem) => (
                            <div key={mem.id} className="flex items-center justify-between gap-3">
                              <div className="min-w-0">
                                <span className="text-sm">{mem.name || mem.username || mem.email || mem.id}</span>
                                {mem.email && (
                                  <span className="ml-2 text-[11px] text-muted-foreground">{mem.email}</span>
                                )}
                              </div>
                              <div className="flex flex-wrap gap-1 justify-end">
                                {mem.roles.length === 0 ? (
                                  <span className="text-[11px] text-muted-foreground/60">no roles</span>
                                ) : (
                                  mem.roles.map((r) => (
                                    <Badge key={r} variant="secondary" className="font-mono">
                                      {r}
                                    </Badge>
                                  ))
                                )}
                              </div>
                            </div>
                          ))}
                          {ms.truncated && (
                            <div className="text-[11px] text-muted-foreground/70">Showing first 50 members.</div>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
