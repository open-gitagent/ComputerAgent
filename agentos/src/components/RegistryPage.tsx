/**
 * Agent registry page — the agents that used to live in the sidebar, rendered
 * as a searchable card grid. Hosted (server-config'd) and Library (registry /
 * SDK-registered) agents are grouped separately. Clicking a card opens that
 * agent's chat dashboard; the Register button opens the registration modal.
 */
import { useMemo, useState } from "react";
import { Search, X } from "lucide-react";
import { api, type Agent } from "../api.ts";
import { AgentCard } from "./AgentCard.tsx";
import { RegisterAgentForm } from "./RegisterAgentForm.tsx";
import { PageHeader } from "./composite/PageHeader.tsx";
import { Input } from "./ui/input.tsx";
import { Skeleton } from "./ui/skeleton.tsx";

function SectionLabel({ name, count }: { name: string; count: number }) {
  return (
    <div className="flex items-center gap-2 px-0.5">
      <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/70">{name}</span>
      <span className="flex-1 h-px bg-border/60" />
      <span className="text-[10px] font-mono text-muted-foreground/50">{count}</span>
    </div>
  );
}

export function RegistryPage({
  agents,
  loaded,
  err,
  selected,
  onOpenAgent,
  onReload,
}: {
  agents: Agent[];
  loaded: boolean;
  err: string | null;
  selected: string | null;
  onOpenAgent: (name: string) => void;
  onReload: () => void;
}) {
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    if (!search.trim()) return agents;
    const q = search.trim().toLowerCase();
    return agents.filter(
      (a) =>
        a.name.toLowerCase().includes(q) ||
        (a.label ?? "").toLowerCase().includes(q) ||
        (a.sourceUrl ?? "").toLowerCase().includes(q) ||
        a.harness.toLowerCase().includes(q),
    );
  }, [agents, search]);

  const grouped = useMemo(() => {
    const hosted = filtered.filter((a) => (a.origin ?? "in-memory") === "in-memory");
    const library = filtered.filter((a) => a.origin === "registry");
    return { hosted, library };
  }, [filtered]);

  return (
    <>
      <PageHeader
        title="Agent Registry"
        description={`${agents.length} agent${agents.length === 1 ? "" : "s"} registered`}
        actions={
          <div className="flex items-center gap-2">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground/60 pointer-events-none" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search agents…"
                className="pl-8 pr-7 h-8 w-56 text-xs bg-background"
              />
              {search && (
                <button
                  onClick={() => setSearch("")}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 h-5 w-5 grid place-items-center rounded text-muted-foreground/70 hover:text-foreground hover:bg-muted"
                  title="Clear"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
            <div className="w-40">
              <RegisterAgentForm onRegistered={onReload} />
            </div>
          </div>
        }
      />

      <div className="flex-1 min-h-0 overflow-auto">
        <div className="p-6 space-y-6">
          {err && <div className="text-xs text-destructive">{err}</div>}

          {!loaded && !err && (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
              {Array.from({ length: 8 }).map((_, i) => (
                <Skeleton key={i} className="h-32 w-full" />
              ))}
            </div>
          )}

          {loaded && agents.length === 0 && !err && (
            <div className="text-center text-sm text-muted-foreground py-16 space-y-1">
              <div>No agents registered yet.</div>
              <div className="text-muted-foreground/70 text-xs">
                Use the <span className="font-mono">Register agent</span> button above.
              </div>
            </div>
          )}

          {agents.length > 0 && filtered.length === 0 && (
            <div className="text-center text-sm text-muted-foreground py-16">
              No agents match <span className="font-mono">"{search}"</span>
            </div>
          )}

          {grouped.hosted.length > 0 && (
            <section className="space-y-3">
              <SectionLabel name="Hosted" count={grouped.hosted.length} />
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
                {grouped.hosted.map((a) => (
                  <AgentCard key={a.name} agent={a} selected={selected === a.name} onClick={() => onOpenAgent(a.name)} />
                ))}
              </div>
            </section>
          )}

          {grouped.library.length > 0 && (
            <section className="space-y-3">
              <SectionLabel name="Library" count={grouped.library.length} />
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
                {grouped.library.map((a) => (
                  <AgentCard key={a.name} agent={a} selected={selected === a.name} onClick={() => onOpenAgent(a.name)} />
                ))}
              </div>
            </section>
          )}
        </div>
      </div>
    </>
  );
}
