import { useEffect, useMemo, useState } from "react";
import { api, type Agent } from "./api.ts";
import { LogsTab } from "./components/LogsTab.tsx";
import { ChatTab } from "./components/ChatTab.tsx";
import { SessionsTab } from "./components/SessionsTab.tsx";
import { HomePage } from "./components/HomePage.tsx";

type Tab = "logs" | "chat" | "sessions";
type View = "home" | "dashboard";

function timeAgo(iso: string | null): string {
  if (!iso) return "never";
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// Friendly name for an agent (a repo source) — "…/general-agent" → "General Agent".
function agentNameFromSource(source: string): string {
  const slug = source.split("/").pop() ?? source;
  return slug.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

interface AgentGroup {
  id: string;            // the source repo (the real "agent")
  name: string;          // friendly display name
  source: string;
  types: Agent[];        // the harness types this agent can run as
  sessionCount: number;
  logCount: number;
  lastActivity: string | null;
  active: boolean;
}

export default function App() {
  const [view, setView] = useState<View>("home");
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedGroup, setSelectedGroup] = useState<string | null>(null);
  const [selectedType, setSelectedType] = useState<string | null>(null); // agent (type) name
  const [tab, setTab] = useState<Tab>("logs");
  const [err, setErr] = useState<string | null>(null);
  const [resumeSessionId, setResumeSessionId] = useState<string | null>(null);
  const [launchMessage, setLaunchMessage] = useState<string | null>(null);

  useEffect(() => {
    api.agents().then(setAgents).catch((e) => setErr(String(e)));
  }, []);

  // Collapse the type-agents into one group per source repo (the real agent).
  const groups = useMemo<AgentGroup[]>(() => {
    const bySource = new Map<string, Agent[]>();
    for (const a of agents) {
      const arr = bySource.get(a.source) ?? [];
      arr.push(a);
      bySource.set(a.source, arr);
    }
    return [...bySource.entries()].map(([source, types]) => ({
      id: source,
      name: agentNameFromSource(source),
      source,
      types,
      sessionCount: types.reduce((n, t) => n + t.sessionCount, 0),
      logCount: types.reduce((n, t) => n + t.logCount, 0),
      lastActivity: types.reduce<string | null>((acc, t) =>
        t.lastActivity && (!acc || t.lastActivity > acc) ? t.lastActivity : acc, null),
      active: types.some((t) => t.activeSandboxes > 0),
    }));
  }, [agents]);

  const group = groups.find((g) => g.id === selectedGroup) ?? null;
  const type = group?.types.find((t) => t.name === selectedType) ?? group?.types[0] ?? null;

  const openGroup = (g: AgentGroup) => {
    setSelectedGroup(g.id);
    // Prefer gitagent as the default type, else the first.
    const def = g.types.find((t) => t.name === "gitagent") ?? g.types[0];
    setSelectedType(def?.name ?? null);
    setView("dashboard");
  };

  const continueInChat = (sessionId: string) => { setResumeSessionId(sessionId); setTab("chat"); };

  // From Home: pick the type's group, select that type, open Chat, send the prompt.
  const launchFromHome = (agentName: string, message: string) => {
    const a = agents.find((x) => x.name === agentName);
    if (!a) return;
    setSelectedGroup(a.source);
    setSelectedType(a.name);
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
          {groups.length === 0 && !err && <div className="m-2 text-xs text-gray-500">Loading…</div>}
          {groups.map((g) => (
            <button
              key={g.id}
              onClick={() => openGroup(g)}
              className={`w-full text-left rounded-lg px-3 py-2.5 transition ${
                view === "dashboard" && selectedGroup === g.id ? "bg-ink-600 ring-1 ring-accent/40" : "hover:bg-ink-700"
              }`}
            >
              <div className="flex items-center gap-2">
                <span className={`h-2 w-2 rounded-full ${g.active ? "bg-emerald-400" : "bg-gray-600"}`} />
                <span className="font-medium text-sm">{g.name}</span>
                <span className="ml-auto text-[10px] rounded bg-ink-500 px-1.5 py-0.5 text-gray-400">{g.types.length} types</span>
              </div>
              <div className="mt-1 text-[11px] text-gray-500 truncate">{g.source}</div>
              <div className="mt-1.5 flex gap-3 text-[10px] text-gray-500">
                <span>{g.sessionCount} sessions</span>
                <span>{g.logCount} logs</span>
                <span>{timeAgo(g.lastActivity)}</span>
              </div>
            </button>
          ))}
        </div>
        <div className="px-4 py-3 border-t border-ink-600 text-[10px] text-gray-600">agentos.clawagent.sh</div>
      </aside>

      {/* Main */}
      <main className="flex-1 flex flex-col min-w-0">
        {view === "home" ? (
          <HomePage onLaunch={launchFromHome} onOpenDashboard={() => groups[0] && openGroup(groups[0])} />
        ) : group && type ? (
          <>
            <header className="px-6 py-4 border-b border-ink-600">
              <div className="flex items-center gap-4">
                <div>
                  <div className="text-base font-semibold">{group.name}</div>
                  <div className="text-xs text-gray-500">{group.source}</div>
                </div>
                <nav className="ml-auto flex gap-1 bg-ink-800 rounded-lg p-1">
                  {(["logs", "chat", "sessions"] as Tab[]).map((t) => (
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
              </div>
              {/* Type selector — the harness this agent runs as */}
              <div className="mt-3 flex items-center gap-2">
                <span className="text-[11px] uppercase tracking-wider text-gray-500 mr-1">Type</span>
                {group.types.map((t) => (
                  <button
                    key={t.name}
                    onClick={() => setSelectedType(t.name)}
                    className={`px-3 py-1 rounded-full text-xs transition border ${
                      selectedType === t.name
                        ? "bg-ink-600 border-accent/50 text-gray-100"
                        : "border-ink-600 text-gray-400 hover:text-gray-200 hover:border-ink-500"
                    }`}
                  >
                    {t.label}
                    <span className="ml-1.5 text-[10px] text-gray-500">{t.harness}</span>
                  </button>
                ))}
                {!type.sandboxCapable && <span className="text-[11px] text-amber-400/80">one-shot · no memory across turns</span>}
              </div>
            </header>
            <section className="flex-1 min-h-0">
              {tab === "logs" && <LogsTab agent={type.name} key={type.name} />}
              {tab === "chat" && (
                <ChatTab
                  key={type.name}
                  agent={type.name}
                  sandboxCapable={type.sandboxCapable}
                  resumeSessionId={resumeSessionId}
                  onConsumedResume={() => setResumeSessionId(null)}
                  initialMessage={launchMessage}
                  onConsumedInitial={() => setLaunchMessage(null)}
                />
              )}
              {tab === "sessions" && <SessionsTab agent={type.name} key={type.name} onContinue={continueInChat} />}
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
