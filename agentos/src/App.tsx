import { useEffect, useState } from "react";
import { api, type Agent } from "./api.ts";
import { LogsTab } from "./components/LogsTab.tsx";
import { WorkspaceTab } from "./components/WorkspaceTab.tsx";
import { HomePage } from "./components/HomePage.tsx";

type Tab = "chat" | "logs";
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
function agentNameFromSource(source: string): string {
  const slug = source.split("/").pop() ?? source;
  return slug.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export default function App() {
  const [view, setView] = useState<View>("home");
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("chat");
  const [err, setErr] = useState<string | null>(null);
  const [launchMessage, setLaunchMessage] = useState<string | null>(null);

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
      <aside className="w-72 shrink-0 border-r border-ink-600 bg-ink-800 flex flex-col">
        <div className="px-5 py-4 border-b border-ink-600">
          <div className="text-lg font-semibold tracking-tight flex items-center gap-2">
            <img src="/logos/agentos.png" alt="AgentOS" className="h-7 w-7 rounded-md object-contain" />
            AgentOS
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
        <div className="px-3 py-3 text-[11px] uppercase tracking-wider text-gray-500">Agents</div>
        <div className="flex-1 overflow-y-auto px-2 space-y-1">
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
              <div className="flex items-center gap-2">
                <span className={`h-2 w-2 rounded-full ${a.activeSandboxes > 0 ? "bg-emerald-400" : "bg-gray-600"}`} />
                <span className="font-medium text-sm">{agentNameFromSource(a.source)}</span>
                <span className="ml-auto text-[10px] rounded bg-accent/20 text-accent-soft px-1.5 py-0.5">{a.label}</span>
              </div>
              <div className="mt-1 text-[11px] text-gray-500 truncate">{a.source}</div>
              <div className="mt-1.5 flex gap-3 text-[10px] text-gray-500">
                <span>{a.sessionCount} sessions</span>
                <span>{a.logCount} logs</span>
                <span>{timeAgo(a.lastActivity)}</span>
              </div>
            </button>
          ))}
        </div>
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
                  <span className="text-base font-semibold">{agentNameFromSource(agent.source)}</span>
                  <span className="text-[10px] rounded bg-accent/20 text-accent-soft px-1.5 py-0.5">{agent.label}</span>
                </div>
                <div className="text-xs text-gray-500">
                  {agent.harness} · {agent.model ?? "default model"}
                  {!agent.sandboxCapable && <span className="ml-2 text-amber-400/80">one-shot · no memory across turns</span>}
                </div>
              </div>
              <nav className="ml-auto flex gap-1 bg-ink-800 rounded-lg p-1">
                {(["chat", "logs"] as Tab[]).map((t) => (
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
