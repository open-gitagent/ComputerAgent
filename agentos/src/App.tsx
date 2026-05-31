import { useEffect, useMemo, useState } from "react";
import {
  Home as HomeIcon,
  Activity,
  Shield,
  ChevronRight,
  ChevronDown,
  Folder,
  FolderOpen,
  Search,
  X,
} from "lucide-react";
import { api, type Agent } from "./api.ts";
import { LogsTab } from "./components/LogsTab.tsx";
import { WorkspaceTab } from "./components/WorkspaceTab.tsx";
import { SchedulesTab } from "./components/SchedulesTab.tsx";
import { HomePage } from "./components/HomePage.tsx";
import { PolicyTab } from "./components/PolicyTab.tsx";
import { PoliciesPage } from "./components/PoliciesPage.tsx";
import { ObservabilityTab } from "./components/observability/ObservabilityTab.tsx";
import { AgentCard } from "./components/AgentCard.tsx";
import { RegisterAgentForm } from "./components/RegisterAgentForm.tsx";
import { Tabs, TabsList, TabsTrigger } from "./components/ui/tabs.tsx";
import { Badge } from "./components/ui/badge.tsx";
import { ScrollArea } from "./components/ui/scroll-area.tsx";
import { Skeleton } from "./components/ui/skeleton.tsx";
import { Separator } from "./components/ui/separator.tsx";
import { Input } from "./components/ui/input.tsx";
import { StatusDot } from "./components/composite/StatusDot.tsx";
import { PageHeader } from "./components/composite/PageHeader.tsx";
import { cn } from "./lib/cn.ts";

type Tab = "chat" | "schedules" | "policy" | "logs";
type View = "home" | "observability" | "policies" | "dashboard";

function timeAgo(iso: string | null): string {
  if (!iso) return "never";
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

const NAME_OVERRIDES: Record<string, string> = {
  "general-agent": "General Agent",
  "agentos-builder": "AgentOS Builder",
  "gap-promoter": "GAP Promoter",
  "framework-translator-agent": "Framework Translator",
};
function agentNameFromSource(source: string): string {
  const slug = source.split("/").pop() ?? source;
  return NAME_OVERRIDES[slug] ?? slug.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function typeLogo(harness: string): string | null {
  if (harness === "gitagent") return "/logos/gitagent.png";
  if (harness === "claude-agent-sdk") return "/logos/claude.svg";
  if (harness === "deepagents") return "/logos/langchain.svg";
  return null;
}

function SectionLabel({ name, count }: { name: string; count: number }) {
  return (
    <div className="flex items-center gap-2 px-1">
      <span className="text-[9.5px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/70">
        {name}
      </span>
      <span className="flex-1 h-px bg-border/60" />
      <span className="text-[9.5px] font-mono text-muted-foreground/50">{count}</span>
    </div>
  );
}

function TypeBadge({ agent, className = "" }: { agent: Agent; className?: string }) {
  const logo = typeLogo(agent.harness);
  return (
    <Badge variant="secondary" className={cn("gap-1.5 pl-1 pr-2 py-0.5 text-[10px] font-normal", className)}>
      {logo && (
        <span className="h-3.5 w-3.5 grid place-items-center rounded-sm bg-background shrink-0">
          <img src={logo} alt="" className="h-2.5 w-2.5 object-contain" />
        </span>
      )}
      <span className="truncate">{agent.label}</span>
    </Badge>
  );
}

export default function App() {
  const [view, setView] = useState<View>("home");
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("chat");
  const [err, setErr] = useState<string | null>(null);
  const [launchMessage, setLaunchMessage] = useState<string | null>(null);
  const [agentsOpen, setAgentsOpen] = useState(true);
  const [search, setSearch] = useState("");

  const filteredAgents = useMemo(() => {
    if (!search.trim()) return agents;
    const q = search.trim().toLowerCase();
    return agents.filter((a) =>
      a.name.toLowerCase().includes(q) ||
      (a.label ?? "").toLowerCase().includes(q) ||
      (a.sourceUrl ?? "").toLowerCase().includes(q) ||
      a.harness.toLowerCase().includes(q),
    );
  }, [agents, search]);

  // Group by origin so Hosted (server-config'd) and Library (registry,
  // dashboard- or SDK-registered) are visually separated.
  const grouped = useMemo(() => {
    const hosted = filteredAgents.filter((a) => (a.origin ?? "in-memory") === "in-memory");
    const library = filteredAgents.filter((a) => a.origin === "registry");
    return { hosted, library };
  }, [filteredAgents]);

  useEffect(() => {
    api.agents().then(setAgents).catch((e) => setErr(String(e)));
  }, []);

  const agent = agents.find((a) => a.name === selected) ?? null;

  const openAgent = (name: string) => {
    setSelected(name);
    setTab("chat");
    setView("dashboard");
  };

  const launchFromHome = (agentName: string, message: string) => {
    setSelected(agentName);
    setTab("chat");
    setLaunchMessage(message);
    setView("dashboard");
  };

  return (
    <div className="flex h-full bg-background text-foreground">
      {/* Left rail */}
      <aside className="w-64 md:w-72 lg:w-80 shrink-0 border-r border-border bg-card flex flex-col overflow-hidden">
        <div className="px-5 py-4 border-b border-border">
          <div className="flex items-center gap-2.5">
            <img src="/logos/agentos.png" alt="ComputerAgent" className="h-8 w-8 rounded-md object-contain" />
            <div className="leading-tight">
              <div className="text-sm font-semibold tracking-tight">ComputerAgent</div>
              <div className="text-[11px] text-muted-foreground font-mono">Console</div>
            </div>
          </div>
        </div>

        <nav className="px-2 pt-2 space-y-1">
          <RailButton
            icon={HomeIcon}
            label="Home"
            active={view === "home"}
            onClick={() => setView("home")}
          />
          <RailButton
            icon={Activity}
            label="Observability"
            active={view === "observability"}
            onClick={() => setView("observability")}
          />
          <RailButton
            icon={Shield}
            label="Policies"
            active={view === "policies"}
            onClick={() => setView("policies")}
          />
        </nav>

        {/* Agents folder */}
        <div className="px-2 pt-3">
          <button
            onClick={() => setAgentsOpen((o) => !o)}
            className="w-full flex items-center gap-1.5 px-3 py-1.5 text-xs uppercase tracking-wider rounded-md hover:bg-muted text-muted-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {agentsOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            {agentsOpen ? <FolderOpen className="h-3.5 w-3.5" /> : <Folder className="h-3.5 w-3.5" />}
            <span className="font-medium">Agents</span>
            <span className="ml-auto text-[10px] text-muted-foreground/70">{agents.length || ""}</span>
          </button>
        </div>

        {agentsOpen && (
          <>
            {/* Search — sticky at top of the rail, opaque so cards never
                appear "behind" it as they scroll. */}
            <div className="px-3 pt-2 pb-2 bg-card border-b border-border/60 relative z-10">
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground/60 pointer-events-none" />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search agents…"
                  className="pl-8 pr-7 h-8 text-xs bg-background"
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
            </div>

            <div className="flex-1 overflow-y-auto overflow-x-hidden mt-2 min-w-0">
              <div className="px-3 pb-3 space-y-3 min-w-0">
                {err && <div className="text-xs text-destructive">{err}</div>}
                {agents.length === 0 && !err && (
                  <div className="space-y-2">
                    <Skeleton className="h-20 w-full" />
                    <Skeleton className="h-20 w-full" />
                    <Skeleton className="h-20 w-full" />
                  </div>
                )}
                {agents.length > 0 && filteredAgents.length === 0 && (
                  <div className="text-center text-xs text-muted-foreground py-6">
                    No agents match <span className="font-mono">"{search}"</span>
                  </div>
                )}

                {grouped.hosted.length > 0 && (
                  <div className="space-y-2 min-w-0">
                    <SectionLabel name="Hosted" count={grouped.hosted.length} />
                    {grouped.hosted.map((a) => (
                      <AgentCard
                        key={a.name}
                        agent={a}
                        selected={view === "dashboard" && selected === a.name}
                        onClick={() => openAgent(a.name)}
                      />
                    ))}
                  </div>
                )}

                {grouped.library.length > 0 && (
                  <div className="space-y-2 min-w-0">
                    <SectionLabel name="Library" count={grouped.library.length} />
                    {grouped.library.map((a) => (
                      <AgentCard
                        key={a.name}
                        agent={a}
                        selected={view === "dashboard" && selected === a.name}
                        onClick={() => openAgent(a.name)}
                      />
                    ))}
                  </div>
                )}

                <div className="pt-2">
                  <RegisterAgentForm onRegistered={() => api.agents().then(setAgents).catch(() => {})} />
                </div>
              </div>
            </div>
          </>
        )}

        <Separator />
        <div className="px-4 py-3 text-[10px] text-muted-foreground/70">AgentOS</div>
      </aside>

      {/* Main */}
      <main className="flex-1 flex flex-col min-w-0">
        {view === "policies" ? (
          <PoliciesPage />
        ) : view === "home" ? (
          <HomePage onLaunch={launchFromHome} onOpenDashboard={() => agents[0] && openAgent(agents[0].name)} />
        ) : view === "observability" ? (
          <ObservabilityTab />
        ) : agent ? (
          <>
            <PageHeader
              title={
                <span className="flex items-center gap-2">
                  {agentNameFromSource(agent.sourceUrl ?? "")}
                  <TypeBadge agent={agent} />
                </span>
              }
              description={
                <>
                  {agent.harness} · {agent.model ?? "default model"}
                  {!agent.sandboxCapable && (
                    <span className="ml-2 text-warning">one-shot · no memory across turns</span>
                  )}
                </>
              }
              actions={
                <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
                  <TabsList>
                    <TabsTrigger value="chat">Chat</TabsTrigger>
                    <TabsTrigger value="schedules">Schedules</TabsTrigger>
                    <TabsTrigger value="policy">Policy</TabsTrigger>
                    <TabsTrigger value="logs">Logs</TabsTrigger>
                  </TabsList>
                </Tabs>
              }
            />
            <section className="flex-1 min-h-0">
              {tab === "chat" && (
                <WorkspaceTab
                  key={agent.name}
                  agent={agent.name}
                  sandboxCapable={agent.sandboxCapable}
                  initialMessage={launchMessage}
                  onConsumedInitial={() => setLaunchMessage(null)}
                />
              )}
              {tab === "schedules" && <SchedulesTab key={agent.name} agent={agent.name} agentLabel={agent.label} />}
              {tab === "policy" && (
                <PolicyTab
                  key={agent.name}
                  agent={agent.name}
                  agentLabel={agent.label}
                  onManagePolicies={() => setView("policies")}
                />
              )}
              {tab === "logs" && <LogsTab key={agent.name} agent={agent.name} />}
            </section>
          </>
        ) : (
          <div className="flex-1 grid place-items-center text-muted-foreground">
            {err ? <span className="text-destructive">{err}</span> : "Select an agent"}
          </div>
        )}
      </main>
    </div>
  );
}

function RailButton({
  icon: Icon,
  label,
  active,
  onClick,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "w-full text-left rounded-md px-3 py-2 text-sm transition-colors flex items-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        active ? "bg-muted ring-1 ring-primary/40 text-foreground" : "hover:bg-muted/60 text-muted-foreground",
      )}
    >
      <Icon className="h-4 w-4" />
      <span>{label}</span>
    </button>
  );
}
