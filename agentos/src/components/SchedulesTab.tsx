import { useEffect, useState } from "react";
import { api, type Schedule } from "../api.ts";

export function SchedulesTab({ agent, agentLabel }: { agent: string; agentLabel: string }) {
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  // Create form
  const [prompt, setPrompt] = useState("");
  const [kind, setKind] = useState<"interval" | "daily">("interval");
  const [intervalMinutes, setIntervalMinutes] = useState(60);
  const [hourUtc, setHourUtc] = useState(9);
  const [minuteUtc, setMinuteUtc] = useState(0);
  const [creating, setCreating] = useState(false);

  const load = () => {
    setLoading(true);
    api.schedules(agent).then(setSchedules).catch((e) => setErr(String(e))).finally(() => setLoading(false));
  };
  useEffect(load, [agent]);

  const create = async () => {
    if (!prompt.trim() || creating) return;
    setCreating(true);
    try {
      await api.createSchedule({
        agentName: agent, prompt: prompt.trim(), kind,
        ...(kind === "interval" ? { intervalMinutes } : { hourUtc, minuteUtc }),
      });
      setPrompt("");
      load();
    } catch (e) { setErr(String(e)); } finally { setCreating(false); }
  };

  const toggle = async (s: Schedule) => { await api.updateSchedule(s._id, { enabled: !s.enabled }); load(); };
  const remove = async (s: Schedule) => { await api.deleteSchedule(s._id); load(); };
  const runNow = async (s: Schedule) => { await api.runScheduleNow(s._id); setTimeout(load, 1500); };

  return (
    <div className="h-full overflow-y-auto px-6 py-5 max-w-3xl">
      {/* Create */}
      <div className="rounded-xl border border-ink-600 bg-ink-800 p-4">
        <div className="text-sm font-medium mb-3">Schedule a run · <span className="text-gray-400">{agentLabel}</span></div>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="What should the agent do on each run? e.g. 'Summarize new issues in the repo and post the highlights.'"
          rows={3}
          className="w-full resize-none rounded-lg bg-ink-900 border border-ink-600 px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-accent placeholder:text-gray-600"
        />
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <div className="flex rounded-lg bg-ink-900 p-1 text-xs">
            {(["interval", "daily"] as const).map((k) => (
              <button key={k} onClick={() => setKind(k)}
                className={`px-3 py-1 rounded-md capitalize ${kind === k ? "bg-accent text-white" : "text-gray-400"}`}>{k}</button>
            ))}
          </div>
          {kind === "interval" ? (
            <label className="flex items-center gap-2 text-sm text-gray-400">
              every
              <select value={intervalMinutes} onChange={(e) => setIntervalMinutes(Number(e.target.value))}
                className="bg-ink-900 border border-ink-600 rounded px-2 py-1 text-gray-200">
                {[5, 10, 15, 30, 60, 180, 360, 720, 1440].map((m) => (
                  <option key={m} value={m}>{m % 60 === 0 ? `${m / 60}h` : `${m}m`}</option>
                ))}
              </select>
            </label>
          ) : (
            <label className="flex items-center gap-2 text-sm text-gray-400">
              daily at
              <input type="number" min={0} max={23} value={hourUtc} onChange={(e) => setHourUtc(Number(e.target.value))}
                className="w-14 bg-ink-900 border border-ink-600 rounded px-2 py-1 text-gray-200" />
              :
              <input type="number" min={0} max={59} value={minuteUtc} onChange={(e) => setMinuteUtc(Number(e.target.value))}
                className="w-14 bg-ink-900 border border-ink-600 rounded px-2 py-1 text-gray-200" />
              <span className="text-xs text-gray-600">UTC</span>
            </label>
          )}
          <button onClick={create} disabled={!prompt.trim() || creating}
            className="ml-auto px-4 py-1.5 rounded-lg bg-accent hover:bg-accent-soft disabled:opacity-40 text-white text-sm font-medium">
            {creating ? "…" : "Create schedule"}
          </button>
        </div>
      </div>

      {/* List */}
      <div className="mt-6 text-[11px] uppercase tracking-wider text-gray-500 mb-2">Schedules</div>
      {err && <div className="text-red-400 text-sm mb-2">{err}</div>}
      {loading && <div className="text-gray-500 text-sm">Loading…</div>}
      {!loading && schedules.length === 0 && <div className="text-gray-600 text-sm">No schedules yet.</div>}
      <div className="space-y-2">
        {schedules.map((s) => (
          <div key={s._id} className="rounded-xl border border-ink-700 bg-ink-800/60 p-4">
            <div className="flex items-start gap-3">
              <button onClick={() => toggle(s)} title={s.enabled ? "Disable" : "Enable"}
                className={`mt-0.5 h-5 w-9 rounded-full transition relative shrink-0 ${s.enabled ? "bg-accent" : "bg-ink-600"}`}>
                <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition ${s.enabled ? "left-[18px]" : "left-0.5"}`} />
              </button>
              <div className="min-w-0 flex-1">
                <div className="text-sm text-gray-200 break-words">{s.prompt}</div>
                <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-gray-500">
                  <span className="rounded bg-ink-600 px-1.5 py-0.5 text-gray-300">{s.description}</span>
                  <span>next: {new Date(s.nextRunAt).toLocaleString()}</span>
                  {s.lastRunAt && <span>last: {new Date(s.lastRunAt).toLocaleString()}</span>}
                  {s.lastStatus && (
                    <span className={
                      s.lastStatus === "ok" ? "text-emerald-400" :
                      s.lastStatus === "error" ? "text-red-400" : "text-amber-400"
                    }>{s.lastStatus}</span>
                  )}
                </div>
                {s.lastResult && (
                  <div className="mt-2 text-xs text-gray-500 bg-ink-900 rounded p-2 max-h-28 overflow-y-auto whitespace-pre-wrap">{s.lastResult}</div>
                )}
              </div>
              <div className="flex flex-col gap-1.5 shrink-0">
                <button onClick={() => runNow(s)} className="text-xs px-2.5 py-1 rounded bg-ink-700 hover:bg-ink-600 text-gray-200">Run now</button>
                <button onClick={() => remove(s)} className="text-xs px-2.5 py-1 rounded hover:bg-red-500/15 text-red-400">Delete</button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
