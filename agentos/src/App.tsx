import { useCallback, useEffect, useState } from "react";
import { Home as HomeIcon, Activity, Shield, Boxes } from "lucide-react";
import { api, type Agent } from "./api.ts";
import { LogsTab } from "./components/LogsTab.tsx";
import { WorkspaceTab } from "./components/WorkspaceTab.tsx";
import { SchedulesTab } from "./components/SchedulesTab.tsx";
import { HomePage } from "./components/HomePage.tsx";
import { PolicyTab } from "./components/PolicyTab.tsx";
import { PoliciesPage } from "./components/PoliciesPage.tsx";
import { ObservabilityTab } from "./components/observability/ObservabilityTab.tsx";
import { RegistryPage } from "./components/RegistryPage.tsx";
import { Tabs, TabsList, TabsTrigger } from "./components/ui/tabs.tsx";
import { Badge } from "./components/ui/badge.tsx";
import { Separator } from "./components/ui/separator.tsx";
import { PageHeader } from "./components/composite/PageHeader.tsx";
import { cn } from "./lib/cn.ts";

type Tab = "chat" | "schedules" | "policy" | "logs";
type View = "home" | "observability" | "policies" | "registry" | "dashboard";

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
  const [agentsLoaded, setAgentsLoaded] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("chat");
  const [err, setErr] = useState<string | null>(null);
  const [launchMessage, setLaunchMessage] = useState<string | null>(null);

  const reloadAgents = useCallback(() => {
    api
      .agents()
      .then(setAgents)
      .catch((e) => setErr(String(e)))
      .finally(() => setAgentsLoaded(true));
  }, []);

  useEffect(() => {
    reloadAgents();
  }, [reloadAgents]);

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
            icon={Boxes}
            label="Agent Registry"
            active={view === "registry" || view === "dashboard"}
            onClick={() => setView("registry")}
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

        <div className="flex-1" />

        <Separator />
        <div className="px-4 py-3 text-[10px] text-muted-foreground/70">agentos.clawagent.sh</div>
      </aside>

      {/* Main */}
      <main className="flex-1 flex flex-col min-w-0">
        {view === "policies" ? (
          <PoliciesPage />
        ) : view === "home" ? (
          <HomePage agents={agents} onLaunch={launchFromHome} onOpenDashboard={() => agents[0] && openAgent(agents[0].name)} />
        ) : view === "observability" ? (
          <ObservabilityTab />
        ) : view === "registry" ? (
          <RegistryPage
            agents={agents}
            loaded={agentsLoaded}
            err={err}
            selected={selected}
            onOpenAgent={openAgent}
            onReload={reloadAgents}
          />
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
