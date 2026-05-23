import { useEffect, useState } from "react";
import { api, type SessionSummary } from "../api.ts";
import { ChatTab } from "./ChatTab.tsx";

/**
 * Combined workspace: session list on the left, live chat on the right.
 * Clicking a session resumes it in the chat (loads its transcript + memory).
 * "New chat" starts a fresh session.
 */
export function WorkspaceTab({
  agent, sandboxCapable, initialMessage, onConsumedInitial,
}: {
  agent: string;
  sandboxCapable: boolean;
  initialMessage?: string | null;
  onConsumedInitial?: () => void;
}) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [collapsed, setCollapsed] = useState(false);
  // resumeId = the session to load into the chat (null = fresh chat).
  // chatKey forces ChatTab to remount when switching sessions / starting new.
  const [resumeId, setResumeId] = useState<string | null>(null);
  const [chatKey, setChatKey] = useState<string>(() => `new-${Date.now()}`);

  const loadSessions = () => {
    setLoading(true);
    api.sessions(agent, 100)
      .then(setSessions)
      .catch(() => setSessions([]))
      .finally(() => setLoading(false));
  };
  useEffect(loadSessions, [agent]);

  // Reset to a fresh chat whenever the agent changes.
  useEffect(() => { setResumeId(null); setChatKey(`new-${agent}-${Date.now()}`); }, [agent]);

  const openSession = (sid: string) => { setResumeId(sid); setChatKey(`s-${sid}-${Date.now()}`); };
  const newChat = () => { setResumeId(null); setChatKey(`new-${Date.now()}`); };

  return (
    <div className="h-full flex">
      {/* Collapsed: thin rail with an expand button + new-chat shortcut */}
      {collapsed && (
        <div className="w-11 shrink-0 border-r border-ink-700 flex flex-col items-center py-3 gap-3">
          <button onClick={() => setCollapsed(false)} title="Show sessions"
            className="h-7 w-7 grid place-items-center rounded hover:bg-ink-700 text-gray-400">»</button>
          <button onClick={newChat} title="New chat"
            className="h-7 w-7 grid place-items-center rounded bg-accent hover:bg-accent-soft text-white text-sm">+</button>
          <div className="mt-1 text-[10px] text-gray-600 [writing-mode:vertical-rl] rotate-180 tracking-wide">
            {sessions.length} sessions
          </div>
        </div>
      )}

      {/* Session list */}
      {!collapsed && (
      <div className="w-72 shrink-0 border-r border-ink-700 flex flex-col">
        <div className="px-4 py-3 border-b border-ink-700 flex items-center gap-2">
          <button onClick={() => setCollapsed(true)} title="Collapse"
            className="h-6 w-6 grid place-items-center rounded hover:bg-ink-700 text-gray-400 -ml-1">«</button>
          <span className="text-xs text-gray-400">{sessions.length} session{sessions.length !== 1 ? "s" : ""}</span>
          <button onClick={newChat} className="ml-auto text-xs px-2.5 py-1 rounded bg-accent hover:bg-accent-soft text-white">+ New chat</button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {loading && <div className="p-4 text-gray-500 text-sm">Loading…</div>}
          {!loading && sessions.length === 0 && (
            <div className="p-4 text-gray-600 text-xs">
              {sandboxCapable ? "No sessions yet. Start a chat →" : "One-shot agent — runs aren't saved as sessions."}
            </div>
          )}
          {sessions.map((s) => (
            <button
              key={s.sessionId}
              onClick={() => openSession(s.sessionId)}
              className={`w-full text-left px-4 py-3 border-b border-ink-800 transition ${
                resumeId === s.sessionId ? "bg-ink-700" : "hover:bg-ink-800/60"
              }`}
            >
              <div className="text-xs text-gray-300 font-mono truncate">{s.sessionId.replace(/^slack-/, "")}</div>
              <div className="mt-1 flex items-center gap-2 text-[10px] text-gray-600">
                {s.sandboxId && <span className="rounded bg-emerald-500/15 text-emerald-300 px-1.5 py-0.5">warm</span>}
                {s.snapshotId && <span className="rounded bg-ink-500 px-1.5 py-0.5">snapshot</span>}
                <span className="ml-auto">{s.lastMessageAt ? new Date(s.lastMessageAt).toLocaleString() : ""}</span>
              </div>
            </button>
          ))}
        </div>
      </div>
      )}

      {/* Chat */}
      <div className="flex-1 min-w-0">
        <ChatTab
          key={chatKey}
          agent={agent}
          sandboxCapable={sandboxCapable}
          resumeSessionId={resumeId}
          onConsumedResume={() => { /* consumed by remount */ }}
          initialMessage={initialMessage}
          onConsumedInitial={() => { onConsumedInitial?.(); loadSessions(); }}
        />
      </div>
    </div>
  );
}
