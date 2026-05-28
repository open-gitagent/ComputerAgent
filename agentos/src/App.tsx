import { useEffect, useState } from "react";
import { api, type Agent } from "./api.ts";
import { LogsTab } from "./components/LogsTab.tsx";
import { WorkspaceTab } from "./components/WorkspaceTab.tsx";
import { SchedulesTab } from "./components/SchedulesTab.tsx";
import { HomePage } from "./components/HomePage.tsx";
import { RegisterAgentForm } from "./components/RegisterAgentForm.tsx";
import { SourceBadge } from "./components/SourceBadge.tsx";

type Tab = "chat" | "schedules" | "logs";
type View = "home" | "dashboard";

function timeAgo(iso: string | null): string {
  if (!iso) return "never";
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// The agent's name comes from its repo — "…/general-agent" → "General Agent".
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

// Logo for an agent type (harness).
function typeLogo(harness: string): string | null {
  if (harness === "gitagent") return "/logos/gitagent.png";
  if (harness === "claude-agent-sdk") return "/logos/claude.svg";
  if (harness === "deepagents") return "/logos/langchain.svg";
  return null;
}

// Type pill: small logo + label (GitAgent / Claude Code / Deep Agent).
function TypeBadge({ agent, className = "" }: { agent: Agent; className?: string }) {
  const logo = typeLogo(agent.harness);
  return (
    <span
      title={agent.label}
      className={`inline-flex items-center gap-1 text-[10px] rounded bg-accent/20 text-accent-soft pl-1 pr-1.5 py-0.5 shrink-0 whitespace-nowrap max-w-[7.5rem] ${className}`}
    >
      {logo && (
        <span className="h-3.5 w-3.5 grid place-items-center rounded bg-white shrink-0">
          <img src={logo} alt="" className="h-2.5 w-2.5 object-contain" />
        </span>
      )}
      <span className="truncate">{agent.label}</span>
    </span>
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

  useEffect(() => {
    api.agents().then(setAgents).catch((e) => setErr(String(e)));
  }, []);

  const agent = agents.find((a) => a.name === selected) ?? null;

  // Clicking an agent defaults to the Chat workspace (session list + chat).
  const openAgent = (name: string) => { setSelected(name); setTab("chat"); setView("dashboard"); };

  // From Home: open the agent (type) and auto-send the prompt.
  const launchFromHome = (agentName: string, message: string) => {
    setSelected(agentName);
    setTab("chat");
    setLaunchMessage(message);
    setView("dashboard");
  };

  return (
    <div className="flex h-full">
      {/* Left rail */}
      <aside className="w-80 shrink-0 border-r border-ink-600 bg-ink-800 flex flex-col">
        <div className="px-5 py-4 border-b border-ink-600">
          <div className="flex items-center gap-2.5">
            <img src="/logos/agentos.png" alt="ComputerAgent" className="h-8 w-8 rounded-md object-contain" />
            <div className="leading-tight">
              <div className="text-sm font-semibold tracking-tight">ComputerAgent</div>
              <div className="text-[11px] text-accent-soft/80 font-mono">Console</div>
            </div>
          </div>
        </div>
        <div className="px-2 pt-2">
          <button
            onClick={() => setView("home")}
            className={`w-full text-left rounded-lg px-3 py-2 text-sm transition flex items-center gap-2 ${
              view === "home" ? "bg-ink-600 ring-1 ring-accent/40" : "hover:bg-ink-700"
            }`}
          >
            <span>🏠</span> Home
          </button>
        </div>
        {/* Agents folder (file-system style) */}
        <div className="px-2 pt-2">
          <button
            onClick={() => setAgentsOpen((o) => !o)}
            className="w-full flex items-center gap-1.5 px-3 py-2 text-sm rounded-lg hover:bg-ink-700 text-gray-300"
          >
            <span className="w-3 text-[10px] text-gray-500">{agentsOpen ? "▾" : "▸"}</span>
            <span>{agentsOpen ? "📂" : "📁"}</span>
            <span className="font-medium">Agents</span>
            <span className="ml-auto text-[10px] text-gray-600">{agents.length}</span>
          </button>
        </div>
        {agentsOpen && (
          <div className="flex-1 overflow-y-auto pl-3 ml-4 border-l border-ink-700 space-y-1 mt-1 mr-2">
            {err && <div className="m-2 text-xs text-red-400">{err}</div>}
            {agents.length === 0 && !err && <div className="m-2 text-xs text-gray-500">Loading…</div>}
            {agents.map((a) => (
              <button
                key={a.name}
                onClick={() => openAgent(a.name)}
                className={`w-full text-left rounded-lg px-3 py-2.5 transition ${
                  view === "dashboard" && selected === a.name ? "bg-ink-600 ring-1 ring-accent/40" : "hover:bg-ink-700"
                }`}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span className={`h-2 w-2 rounded-full shrink-0 ${a.activeSandboxes > 0 ? "bg-emerald-400" : "bg-gray-600"}`} />
                  <span className="font-medium text-sm truncate min-w-0 flex-1" title={agentNameFromSource(a.sourceUrl ?? "")}>
                    {agentNameFromSource(a.sourceUrl ?? "")}
                  </span>
                  {a.origin === "registry" && (
                    <span
                      className="text-[9px] uppercase tracking-wider text-accent-soft bg-accent/10 rounded px-1.5 py-0.5 shrink-0"
                      title={`Registered via the SDK telemetry hook${a.registeredBy ? ` by ${a.registeredBy}` : ""}`}
                    >
                      lib
                    </span>
                  )}
                  <TypeBadge agent={a} />
                </div>
                <div className="mt-1.5">
                  <SourceBadge agent={a} />
                </div>
                <div className="mt-1.5 flex gap-3 text-[10px] text-gray-500">
                  <span>{a.sessionCount} sessions</span>
                  <span>{a.logCount} logs</span>
                  <span>{timeAgo(a.lastActivity ?? a.lastSeen ?? null)}</span>
                </div>
              </button>
            ))}
            <div className="px-2 pt-3 pb-2">
              <RegisterAgentForm onRegistered={() => api.agents().then(setAgents).catch(() => {})} />
            </div>
          </div>
        )}
        <div className="px-4 py-3 border-t border-ink-600 text-[10px] text-gray-600">agentos.clawagent.sh</div>
      </aside>

      {/* Main */}
      <main className="flex-1 flex flex-col min-w-0">
        {view === "home" ? (
          <HomePage onLaunch={launchFromHome} onOpenDashboard={() => agents[0] && openAgent(agents[0].name)} />
        ) : agent ? (
          <>
            <header className="px-6 py-4 border-b border-ink-600 flex items-center gap-4">
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-base font-semibold">{agentNameFromSource(agent.sourceUrl ?? "")}</span>
                  <TypeBadge agent={agent} />
                </div>
                <div className="text-xs text-gray-500">
                  {agent.harness} · {agent.model ?? "default model"}
                  {!agent.sandboxCapable && <span className="ml-2 text-amber-400/80">one-shot · no memory across turns</span>}
                </div>
              </div>
              <nav className="ml-auto flex gap-1 bg-ink-800 rounded-lg p-1">
                {(["chat", "schedules", "logs"] as Tab[]).map((t) => (
                  <button
                    key={t}
                    onClick={() => setTab(t)}
                    className={`px-3.5 py-1.5 text-sm rounded-md capitalize transition ${
                      tab === t ? "bg-accent text-white" : "text-gray-400 hover:text-gray-200"
                    }`}
                  >
                    {t}
                  </button>
                ))}
              </nav>
            </header>
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
              {tab === "logs" && <LogsTab key={agent.name} agent={agent.name} />}
            </section>
          </>
        ) : (
          <div className="flex-1 grid place-items-center text-gray-600">
            {err ? <span className="text-red-400">{err}</span> : "Select an agent"}
          </div>
        )}
      </main>
    </div>
  );
}
