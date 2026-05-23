import { useEffect, useState } from "react";
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

export default function App() {
  const [view, setView] = useState<View>("home");
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("logs");
  const [err, setErr] = useState<string | null>(null);
  // Handoff: Sessions → "Continue in chat" passes a sessionId to resume.
  const [resumeSessionId, setResumeSessionId] = useState<string | null>(null);
  // Handoff: Home → launch a chat with a prompt.
  const [launchMessage, setLaunchMessage] = useState<string | null>(null);

  useEffect(() => {
    api.agents()
      .then((a) => { setAgents(a); if (a.length && !selected) setSelected(a[0].name); })
      .catch((e) => setErr(String(e)));
  }, []);

  const agent = agents.find((a) => a.name === selected) ?? null;

  const continueInChat = (sessionId: string) => {
    setResumeSessionId(sessionId);
    setTab("chat");
  };

  // From Home: open the agent's Chat tab and auto-send the prompt.
  const launchFromHome = (agentName: string, message: string) => {
    setSelected(agentName);
    setTab("chat");
    setLaunchMessage(message);
    setView("dashboard");
  };

  if (view === "home") {
    return (
      <HomePage
        onLaunch={launchFromHome}
        onOpenDashboard={() => setView("dashboard")}
      />
    );
  }

  return (
    <div className="flex h-full">
      {/* Left rail — agents */}
      <aside className="w-72 shrink-0 border-r border-ink-600 bg-ink-800 flex flex-col">
        <button onClick={() => setView("home")} className="px-5 py-4 border-b border-ink-600 text-left hover:bg-ink-700/50 transition">
          <div className="text-lg font-semibold tracking-tight flex items-center gap-2">
            <span className="h-6 w-6 rounded-md bg-ink-600 grid place-items-center text-sm">◇</span>
            AgentOS
          </div>
          <div className="text-xs text-gray-500 mt-0.5">← home · control panel</div>
        </button>
        <div className="px-3 py-3 text-[11px] uppercase tracking-wider text-gray-500">Agents</div>
        <div className="flex-1 overflow-y-auto px-2 space-y-1">
          {err && <div className="m-2 text-xs text-red-400">{err}</div>}
          {agents.length === 0 && !err && <div className="m-2 text-xs text-gray-500">Loading…</div>}
          {agents.map((a) => (
            <button
              key={a.name}
              onClick={() => setSelected(a.name)}
              className={`w-full text-left rounded-lg px-3 py-2.5 transition ${
                selected === a.name ? "bg-ink-600 ring-1 ring-accent/40" : "hover:bg-ink-700"
              }`}
            >
              <div className="flex items-center gap-2">
                <span className={`h-2 w-2 rounded-full ${a.activeSandboxes > 0 ? "bg-emerald-400" : "bg-gray-600"}`} />
                <span className="font-medium text-sm">{a.label}</span>
                <span className="ml-auto text-[10px] rounded bg-ink-500 px-1.5 py-0.5 text-gray-400">{a.harness}</span>
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
        <div className="px-4 py-3 border-t border-ink-600 text-[10px] text-gray-600">
          agentos.clawagent.sh
        </div>
      </aside>

      {/* Main */}
      <main className="flex-1 flex flex-col min-w-0">
        {agent ? (
          <>
            <header className="px-6 py-4 border-b border-ink-600 flex items-center gap-4">
              <div>
                <div className="text-base font-semibold">{agent.label}</div>
                <div className="text-xs text-gray-500">
                  {agent.harness} · {agent.model ?? "default model"}
                  {!agent.sandboxCapable && <span className="ml-2 text-amber-400/80">one-shot</span>}
                </div>
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
            </header>
            <section className="flex-1 min-h-0">
              {tab === "logs" && <LogsTab agent={agent.name} />}
              {tab === "chat" && (
                <ChatTab
                  agent={agent.name}
                  sandboxCapable={agent.sandboxCapable}
                  resumeSessionId={resumeSessionId}
                  onConsumedResume={() => setResumeSessionId(null)}
                  initialMessage={launchMessage}
                  onConsumedInitial={() => setLaunchMessage(null)}
                />
              )}
              {tab === "sessions" && <SessionsTab agent={agent.name} onContinue={continueInChat} />}
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
