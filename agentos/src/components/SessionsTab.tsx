import { useEffect, useState } from "react";
import { api, type SessionSummary, type SessionDetail } from "../api.ts";

export function SessionsTab({ agent, onContinue }: { agent: string; onContinue: (sessionId: string) => void }) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    api.sessions(agent, 100)
      .then((s) => { setSessions(s); setErr(null); })
      .catch((e) => setErr(String(e)))
      .finally(() => setLoading(false));
  }, [agent]);

  useEffect(() => {
    if (!active) { setDetail(null); return; }
    setDetail(null);
    api.session(active).then(setDetail).catch((e) => setErr(String(e)));
  }, [active]);

  return (
    <div className="h-full flex">
      {/* Session list */}
      <div className="w-80 shrink-0 border-r border-ink-700 overflow-y-auto">
        {err && <div className="p-4 text-red-400 text-sm">{err}</div>}
        {loading && <div className="p-4 text-gray-500 text-sm">Loading…</div>}
        {!loading && sessions.length === 0 && <div className="p-4 text-gray-500 text-sm">No sessions yet.</div>}
        {sessions.map((s) => (
          <button
            key={s.sessionId}
            onClick={() => setActive(s.sessionId)}
            className={`w-full text-left px-4 py-3 border-b border-ink-800 transition ${
              active === s.sessionId ? "bg-ink-700" : "hover:bg-ink-800/60"
            }`}
          >
            <div className="text-xs text-gray-400 font-mono truncate">{s.sessionId.replace(/^slack-/, "")}</div>
            <div className="mt-1 flex items-center gap-2 text-[10px] text-gray-600">
              {s.sandboxId && <span className="rounded bg-emerald-500/15 text-emerald-300 px-1.5 py-0.5">warm</span>}
              {s.snapshotId && <span className="rounded bg-ink-500 px-1.5 py-0.5">snapshot</span>}
              <span className="ml-auto">{s.lastMessageAt ? new Date(s.lastMessageAt).toLocaleString() : ""}</span>
            </div>
          </button>
        ))}
      </div>

      {/* Transcript */}
      <div className="flex-1 min-w-0 flex flex-col">
        {!active && <div className="flex-1 grid place-items-center text-gray-600">Select a session</div>}
        {active && (
          <>
            <div className="px-6 py-3 border-b border-ink-700 flex items-center gap-3">
              <div className="text-sm font-mono text-gray-400 truncate">{active}</div>
              <button
                onClick={() => onContinue(active)}
                className="ml-auto text-xs px-3 py-1.5 rounded bg-accent hover:bg-accent-soft text-white"
              >
                Continue in chat →
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
              {!detail && <div className="text-gray-500 text-sm">Loading transcript…</div>}
              {detail && detail.entries.length === 0 && <div className="text-gray-500 text-sm">No transcript stored for this session.</div>}
              {detail?.entries.map((e, i) => {
                const isUser = e.type.includes("user");
                return (
                  <div key={i} className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
                    <div className={`max-w-[80%] rounded-2xl px-4 py-2.5 text-sm whitespace-pre-wrap break-words ${
                      isUser ? "bg-accent/90 text-white" : "bg-ink-700 text-gray-200"
                    }`}>
                      {e.text || "—"}
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
