import { useEffect, useState } from "react";
import { api, type LogEntry } from "../api.ts";

export function LogsTab({ agent }: { agent: string }) {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    api.logs(agent, 100)
      .then((l) => { setLogs(l); setErr(null); })
      .catch((e) => setErr(String(e)))
      .finally(() => setLoading(false));
  };
  useEffect(load, [agent]);

  return (
    <div className="h-full flex flex-col">
      <div className="px-6 py-3 flex items-center gap-3 border-b border-ink-700">
        <span className="text-sm text-gray-400">{logs.length} request{logs.length !== 1 ? "s" : ""}</span>
        <button onClick={load} className="ml-auto text-xs px-2.5 py-1 rounded bg-ink-700 hover:bg-ink-600">
          Refresh
        </button>
      </div>
      <div className="flex-1 overflow-y-auto">
        {err && <div className="p-6 text-red-400 text-sm">{err}</div>}
        {loading && <div className="p-6 text-gray-500 text-sm">Loading…</div>}
        {!loading && logs.length === 0 && (
          <div className="p-6 text-gray-500 text-sm">
            No logs yet. Requests are recorded from now on — mention the agent in Slack or chat here.
          </div>
        )}
        <div className="divide-y divide-ink-700">
          {logs.map((l) => {
            const open = expanded === l._id;
            return (
              <div key={l._id} className="px-6 py-3 hover:bg-ink-800/50">
                <button className="w-full text-left" onClick={() => setExpanded(open ? null : l._id)}>
                  <div className="flex items-center gap-2 text-xs text-gray-500">
                    <span className={`rounded px-1.5 py-0.5 ${l.source === "slack" ? "bg-indigo-500/20 text-indigo-300" : "bg-emerald-500/20 text-emerald-300"}`}>
                      {l.source}
                    </span>
                    {!l.ok && <span className="rounded px-1.5 py-0.5 bg-red-500/20 text-red-300">error</span>}
                    <span>{new Date(l.ts).toLocaleString()}</span>
                    <span className="text-gray-600">·</span>
                    <span className="text-gray-400">{l.requester}</span>
                  </div>
                  <div className="mt-1 text-sm text-gray-200 truncate">{l.query || "—"}</div>
                  {!open && <div className="mt-0.5 text-xs text-gray-500 truncate">{l.reply || "—"}</div>}
                </button>
                {open && (
                  <div className="mt-2 space-y-2">
                    <Field label="Query" value={l.query} />
                    <Field label="Reply" value={l.reply} />
                    {l.sessionId && <div className="text-[11px] text-gray-600 font-mono">{l.sessionId}</div>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wider text-gray-500 mb-1">{label}</div>
      <pre className="whitespace-pre-wrap break-words text-sm text-gray-300 bg-ink-800 rounded-lg p-3 max-h-72 overflow-y-auto">{value || "—"}</pre>
    </div>
  );
}
