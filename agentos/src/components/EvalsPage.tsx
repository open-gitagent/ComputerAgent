import { useEffect, useRef, useState } from "react";
import { FlaskConical, Play, Plus, Trash2, ChevronLeft, ChevronRight, CheckCircle2, XCircle, Loader2, Sparkles, LayoutDashboard } from "lucide-react";
import {
  api,
  type EvalSuite,
  type EvalSuiteInput,
  type EvalRun,
  type EvalCase,
  type CaseResult,
  type EvalTraceEntry,
  type ScorerConfig,
  type ScoreResult,
  type JudgeDef,
} from "../api.ts";
import { useAgents } from "../context/AgentsContext.tsx";
import { useAuth } from "../context/AuthContext.tsx";
import { cn } from "../lib/cn.ts";
import { SimDashboard } from "./SimDashboard.tsx";

type RightView = { kind: "empty" } | { kind: "dashboard" } | { kind: "suite"; id: string } | { kind: "edit"; suite: EvalSuite | null } | { kind: "run"; id: string };

export function EvalsPage() {
  const { can } = useAuth();
  // RBAC (UX gating; server authorize() is the boundary). Evals use a single
  // write permission covering create / edit / run / delete of suites.
  const canWrite = can("evals:write");
  const [suites, setSuites] = useState<EvalSuite[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [view, setView] = useState<RightView>({ kind: "dashboard" });

  const load = () => {
    setLoading(true);
    setErr(null);
    api.evals.listSuites().then(setSuites).catch((e) => setErr(String(e))).finally(() => setLoading(false));
  };
  useEffect(load, []);

  return (
    <div className="flex h-full min-h-0">
      {/* Left: suite list */}
      <div className="w-80 shrink-0 border-r border-border bg-card flex flex-col">
        <div className="px-4 py-3 border-b border-border flex items-center justify-between">
          <div className="flex items-center gap-2">
            <FlaskConical className="h-4 w-4 text-primary" />
            <span className="text-sm font-semibold">Agent Simulation Engine</span>
          </div>
          {canWrite && (
            <button
              onClick={() => setView({ kind: "edit", suite: null })}
              className="flex items-center gap-1 text-xs px-2 py-1 rounded bg-primary text-primary-foreground hover:bg-primary/90"
            >
              <Plus className="h-3 w-3" /> New
            </button>
          )}
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          <button
            onClick={() => setView({ kind: "dashboard" })}
            className={cn(
              "w-full text-left rounded-md px-3 py-2 flex items-center gap-2 transition",
              view.kind === "dashboard" ? "bg-muted ring-1 ring-primary/40" : "hover:bg-muted/60",
            )}
          >
            <LayoutDashboard className="h-4 w-4 text-primary shrink-0" />
            <span className="text-sm font-medium">Overview</span>
          </button>
          <div className="px-2 pt-2 pb-1 text-[10px] uppercase tracking-wider text-muted-foreground">Suites</div>
          {loading && <div className="text-xs text-muted-foreground px-2 py-3">Loading…</div>}
          {err && <div className="text-xs text-destructive px-2 py-3">{err}</div>}
          {!loading && suites.length === 0 && (
            <div className="text-xs text-muted-foreground px-2 py-6 text-center">
              No suites yet. Create one to start simulating an agent.
            </div>
          )}
          {suites.map((s) => {
            const active = (view.kind === "suite" && view.id === s._id) || (view.kind === "edit" && view.suite?._id === s._id);
            return (
              <button
                key={s._id}
                onClick={() => setView({ kind: "suite", id: s._id })}
                className={cn(
                  "w-full text-left rounded-md px-3 py-2 transition",
                  active ? "bg-muted ring-1 ring-primary/40" : "hover:bg-muted/60",
                )}
              >
                <div className="text-sm font-medium truncate">{s.name}</div>
                <div className="text-[11px] text-muted-foreground truncate">
                  {s.agentName} · {s.cases.length} case{s.cases.length === 1 ? "" : "s"}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Right: editor / detail / run */}
      <div className="flex-1 min-w-0 overflow-y-auto">
        {view.kind === "empty" && (
          <div className="h-full grid place-items-center text-sm text-muted-foreground">
            Select a suite, or create one to simulate an agent.
          </div>
        )}
        {view.kind === "dashboard" && <SimDashboard onOpenRun={(runId) => setView({ kind: "run", id: runId })} />}
        {view.kind === "edit" && (
          <SuiteEditor
            initial={view.suite}
            canWrite={canWrite}
            onCancel={() => setView(view.suite ? { kind: "suite", id: view.suite._id } : { kind: "empty" })}
            onSaved={(s) => {
              load();
              setView({ kind: "suite", id: s._id });
            }}
          />
        )}
        {view.kind === "suite" && (
          <SuiteDetail
            id={view.id}
            canWrite={canWrite}
            onEdit={(s) => setView({ kind: "edit", suite: s })}
            onDeleted={() => {
              load();
              setView({ kind: "empty" });
            }}
            onOpenRun={(runId) => setView({ kind: "run", id: runId })}
          />
        )}
        {view.kind === "run" && <RunView id={view.id} onBack={(suiteId) => setView({ kind: "suite", id: suiteId })} />}
      </div>
    </div>
  );
}

// ── Suite detail (read) — run + recent runs ─────────────────────────────────
function SuiteDetail({
  id,
  canWrite,
  onEdit,
  onDeleted,
  onOpenRun,
}: {
  id: string;
  canWrite: boolean;
  onEdit: (s: EvalSuite) => void;
  onDeleted: () => void;
  onOpenRun: (runId: string) => void;
}) {
  const [suite, setSuite] = useState<EvalSuite | null>(null);
  const [runs, setRuns] = useState<EvalRun[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const reload = () => {
    api.evals.getSuite(id).then(setSuite).catch((e) => setErr(String(e)));
    api.evals.listRuns(id).then(setRuns).catch(() => {});
  };
  useEffect(reload, [id]);

  if (err) return <div className="p-6 text-sm text-destructive">{err}</div>;
  if (!suite) return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;

  const enabledScorers = (Object.entries(suite.scorers) as [keyof ScorerConfig, boolean][])
    .filter(([, on]) => on)
    .map(([k]) => SCORER_LABEL[k]);

  const run = async () => {
    setBusy(true);
    setErr(null);
    try {
      const { runId } = await api.evals.runSuite(suite._id);
      onOpenRun(runId);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  const del = async () => {
    if (!confirm(`Delete suite "${suite.name}" and its runs?`)) return;
    await api.evals.deleteSuite(suite._id);
    onDeleted();
  };

  return (
    <div className="p-6 max-w-4xl">
      <div className="flex items-start justify-between mb-4">
        <div>
          <h2 className="text-lg font-semibold">{suite.name}</h2>
          {suite.description && <p className="text-sm text-muted-foreground mt-0.5">{suite.description}</p>}
          <div className="text-[11px] text-muted-foreground mt-1 font-mono">
            agent: {suite.agentName} · {suite.cases.length} cases · scorers: {enabledScorers.join(", ") || "none"}
            {suite.passThreshold !== undefined && ` · gate ≥ ${(suite.passThreshold * 100).toFixed(0)}%`}
          </div>
        </div>
        {canWrite && (
          <div className="flex items-center gap-2">
            <button onClick={() => onEdit(suite)} className="px-3 py-1.5 rounded border border-border text-sm hover:bg-muted">
              Edit
            </button>
            <button
              onClick={run}
              disabled={busy}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-primary text-primary-foreground text-sm hover:bg-primary/90 disabled:opacity-50"
            >
              <Play className="h-3.5 w-3.5" /> {busy ? "Starting…" : "Run"}
            </button>
          </div>
        )}
      </div>

      {/* Cases preview */}
      <div className="rounded-lg border border-border bg-card p-4 mb-5">
        <h3 className="text-sm font-semibold mb-3">Cases</h3>
        <div className="space-y-2">
          {suite.cases.map((c, i) => (
            <div key={c.id} className="text-sm flex gap-2">
              <span className="text-muted-foreground shrink-0 w-6">{i + 1}.</span>
              <span className="truncate">{c.prompt}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Runs */}
      <div className="rounded-lg border border-border bg-card p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold">Runs</h3>
          <button onClick={reload} className="text-xs text-muted-foreground hover:text-foreground">Refresh</button>
        </div>
        {runs.length === 0 && <div className="text-xs text-muted-foreground py-2">No runs yet.</div>}
        <div className="space-y-1.5">
          {runs.map((r) => (
            <button
              key={r._id}
              onClick={() => onOpenRun(r._id)}
              className="w-full flex items-center gap-3 text-left rounded px-3 py-2 hover:bg-muted/60"
            >
              <StatusDot status={r.status} />
              <span className="text-sm flex-1 min-w-0 truncate">{new Date(r.startedAt).toLocaleString()}</span>
              <PassPill summary={r.summary} status={r.status} />
            </button>
          ))}
        </div>
      </div>

      {canWrite && (
        <div className="mt-6">
          <button onClick={del} className="flex items-center gap-1.5 text-xs text-destructive hover:text-destructive/80">
            <Trash2 className="h-3.5 w-3.5" /> Delete suite
          </button>
        </div>
      )}
    </div>
  );
}

// ── Run view — live results ─────────────────────────────────────────────────
function RunView({ id, onBack }: { id: string; onBack: (suiteId: string) => void }) {
  const [run, setRun] = useState<EvalRun | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    const poll = () => {
      api.evals
        .getRun(id)
        .then((r) => {
          if (cancelled) return;
          setRun(r);
          if (r.status === "running") timer.current = setTimeout(poll, 1500);
        })
        .catch((e) => !cancelled && setErr(String(e)));
    };
    poll();
    return () => {
      cancelled = true;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [id]);

  if (err) return <div className="p-6 text-sm text-destructive">{err}</div>;
  if (!run) return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;

  const pct = (run.summary.passRate * 100).toFixed(0);

  return (
    <div className="p-6 max-w-5xl">
      <button onClick={() => onBack(run.suiteId)} className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground mb-3">
        <ChevronLeft className="h-3.5 w-3.5" /> {run.suiteName}
      </button>

      {/* Summary */}
      <div className="rounded-lg border border-border bg-card p-4 mb-5">
        <div className="flex items-center gap-4">
          <StatusDot status={run.status} large />
          <div>
            <div className="text-2xl font-semibold">
              {run.summary.passed}/{run.summary.total} <span className="text-base text-muted-foreground">passed ({pct}%)</span>
            </div>
            <div className="text-[11px] text-muted-foreground font-mono">
              {run.status === "running" ? "running…" : run.status} · agent {run.agentName}
              {run.summary.gatePassed !== undefined && (
                <span className={run.summary.gatePassed ? " text-emerald-500" : " text-destructive"}>
                  {" "}· gate {run.summary.gatePassed ? "PASS" : "FAIL"}
                </span>
              )}
            </div>
          </div>
          <div className="ml-auto h-2 w-40 rounded-full bg-muted overflow-hidden">
            <div className="h-full bg-primary transition-all" style={{ width: `${pct}%` }} />
          </div>
        </div>
        {run.error && <div className="mt-2 text-sm text-destructive">{run.error}</div>}
      </div>

      {/* Results table */}
      <div className="rounded-lg border border-border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-[11px] uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="w-8 py-2"></th>
              <th className="w-8 py-2 text-left font-medium">#</th>
              <th className="py-2 text-left font-medium">Case</th>
              <th className="py-2 text-left font-medium">Scores</th>
              <th className="py-2 text-right font-medium pr-3">Cost</th>
              <th className="py-2 text-right font-medium pr-4">Latency</th>
            </tr>
          </thead>
          <tbody>
            {run.results.map((c, i) => (
              <CaseRows key={c.caseId} c={c} i={i} open={openId === c.caseId} onToggle={() => setOpenId(openId === c.caseId ? null : c.caseId)} />
            ))}
            {run.status === "running" && run.results.length < run.summary.total && (
              <tr>
                <td colSpan={6} className="px-4 py-2.5 text-xs text-muted-foreground">
                  <span className="flex items-center gap-2">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" /> running case {run.results.length + 1} of {run.summary.total}…
                  </span>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function CaseRows({ c, i, open, onToggle }: { c: CaseResult; i: number; open: boolean; onToggle: () => void }) {
  return (
    <>
      <tr onClick={onToggle} className={cn("border-t border-border/50 cursor-pointer hover:bg-muted/30", open && "bg-muted/30")}>
        <td className="py-2 pl-3">
          <ChevronRight className={cn("h-3.5 w-3.5 text-muted-foreground transition-transform", open && "rotate-90")} />
        </td>
        <td className="py-2 text-muted-foreground text-xs">{i + 1}</td>
        <td className="py-2 pr-3">
          <div className="flex items-center gap-2 min-w-0">
            {c.passed ? <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0" /> : <XCircle className="h-4 w-4 text-destructive shrink-0" />}
            <span className="truncate max-w-md">{c.prompt}</span>
          </div>
        </td>
        <td className="py-2">
          <div className="flex flex-wrap gap-1">
            {c.scores.map((s, i) => (
              <MiniScore key={`${s.scorer}-${s.label ?? i}`} s={s} />
            ))}
            {c.scores.length === 0 && <span className="text-[11px] text-muted-foreground">—</span>}
          </div>
        </td>
        <td className="py-2 text-right font-mono text-xs text-muted-foreground pr-3">${c.costUsd.toFixed(4)}</td>
        <td className="py-2 text-right font-mono text-xs text-muted-foreground pr-4">{Math.round(c.latencyMs)}ms</td>
      </tr>
      {open && (
        <tr className="bg-background">
          <td colSpan={6} className="px-4 py-3 border-t border-border/50">
            <CaseDetail c={c} />
          </td>
        </tr>
      )}
    </>
  );
}

function CaseDetail({ c }: { c: CaseResult }) {
  return (
    <div className="space-y-3">
      {/* Scores with reasons */}
      <div className="space-y-1">
        {c.scores.map((s, i) => (
          <div key={`${s.scorer}-${s.label ?? i}`} className="flex items-start gap-2 text-xs">
            <span className={cn("mt-0.5", s.passed ? "text-emerald-500" : "text-destructive")}>{s.passed ? "✓" : "✕"}</span>
            <span className="w-44 shrink-0 text-muted-foreground">{scoreLabel(s)}</span>
            <span className="flex-1">{s.detail}</span>
          </div>
        ))}
      </div>

      {c.error && <Field label="Error"><span className="text-destructive text-xs">{c.error}</span></Field>}

      <div className="grid grid-cols-2 gap-4">
        <Field label="Final output">
          <pre className="text-xs whitespace-pre-wrap bg-card border border-border rounded p-2 max-h-40 overflow-y-auto">{c.output || "(empty)"}</pre>
        </Field>
        <div className="space-y-2">
          {c.toolCalls.length > 0 && (
            <Field label="Tool calls">
              <span className="text-xs font-mono">{c.toolCalls.join(", ")}</span>
            </Field>
          )}
          {c.policyDenials.length > 0 && (
            <Field label="Policy denials">
              <div className="space-y-0.5">
                {c.policyDenials.map((d, i) => (
                  <div key={i} className="text-xs"><span className="font-mono text-destructive">{d.tool}</span> — {d.reason}</div>
                ))}
              </div>
            </Field>
          )}
        </div>
      </div>

      {/* Trace / log */}
      {c.transcript && c.transcript.length > 0 && (
        <Field label={`Trace / log (${c.transcript.length} steps)`}>
          <div className="rounded border border-border bg-card max-h-80 overflow-y-auto divide-y divide-border/40">
            {c.transcript.map((e, i) => (
              <TraceStep key={i} e={e} />
            ))}
          </div>
        </Field>
      )}
    </div>
  );
}

function TraceStep({ e }: { e: EvalTraceEntry }) {
  const meta: Record<EvalTraceEntry["type"], { label: string; cls: string }> = {
    thinking: { label: "thinking", cls: "text-muted-foreground" },
    text: { label: "assistant", cls: "text-foreground" },
    tool_use: { label: "tool", cls: "text-primary" },
    tool_result: { label: "result", cls: e.isError ? "text-destructive" : "text-emerald-500" },
  };
  const m = meta[e.type];
  return (
    <div className="px-2.5 py-1.5 text-xs">
      <span className={cn("font-mono text-[10px] uppercase tracking-wide mr-2", m.cls)}>{m.label}</span>
      {e.type === "tool_use" ? (
        <span>
          <span className="font-mono text-primary">{e.tool}</span>
          {e.input !== undefined && (
            <pre className="mt-1 bg-background border border-border rounded p-1.5 overflow-x-auto text-[11px]">{JSON.stringify(e.input, null, 2)}</pre>
          )}
        </span>
      ) : (
        <span className={cn("whitespace-pre-wrap", e.type === "thinking" && "italic text-muted-foreground")}>{e.text}</span>
      )}
    </div>
  );
}

function MiniScore({ s }: { s: ScoreResult }) {
  return (
    <span
      title={`${scoreLabel(s)}: ${s.detail ?? ""}`}
      className={cn(
        "inline-flex h-4 w-4 items-center justify-center rounded text-[10px] font-bold",
        s.passed ? "bg-emerald-500/15 text-emerald-500" : "bg-destructive/15 text-destructive",
      )}
    >
      {s.passed ? "✓" : "✕"}
    </span>
  );
}

// ── Suite editor ────────────────────────────────────────────────────────────
const SCORER_LABEL: Record<keyof ScorerConfig, string> = {
  taskSuccess: "Task success (LLM-judge)",
  toolCompliance: "Tool & policy compliance",
  golden: "Golden match",
  nfr: "NFRs (cost/latency)",
};

/** Display name for a score row — the judge's name for LLM-judge scores
 *  (so multiple judges show separately), else the scorer's label. */
function scoreLabel(s: ScoreResult): string {
  if (s.scorer === "taskSuccess" && s.label) return `Judge · ${s.label}`;
  return SCORER_LABEL[s.scorer];
}

function freshCase(i: number): EvalCase {
  return { id: `case-${Date.now()}-${i}`, prompt: "" };
}

/** Initial judges for the editor: the suite's judges[], else a single judge
 *  migrated from the legacy single-judge fields, else one empty default. */
function initialJudges(s: EvalSuite | null | undefined): JudgeDef[] {
  if (s?.judges?.length) return s.judges.map((j) => ({ ...j }));
  if (s && (s.judgePrompt || s.judgeModel || s.judgePassThreshold !== undefined)) {
    return [
      {
        id: "j1",
        name: "Task success",
        ...(s.judgePrompt ? { rubric: s.judgePrompt } : {}),
        ...(s.judgeModel ? { model: s.judgeModel } : {}),
        ...(s.judgePassThreshold !== undefined ? { passThreshold: s.judgePassThreshold } : {}),
      },
    ];
  }
  return [{ id: "j1", name: "Task success" }];
}

function SuiteEditor({
  initial,
  canWrite,
  onCancel,
  onSaved,
}: {
  initial: EvalSuite | null;
  canWrite: boolean;
  onCancel: () => void;
  onSaved: (s: EvalSuite) => void;
}) {
  const { agents } = useAgents();
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [agentName, setAgentName] = useState(initial?.agentName ?? "");
  const [scorers, setScorers] = useState<ScorerConfig>(
    initial?.scorers ?? { taskSuccess: true, toolCompliance: false, golden: false, nfr: false },
  );
  const [judges, setJudges] = useState<JudgeDef[]>(() => initialJudges(initial));
  const updJudge = (idx: number, patch: Partial<JudgeDef>) =>
    setJudges((p) => p.map((j, i) => (i === idx ? { ...j, ...patch } : j)));
  const addJudge = () =>
    setJudges((p) => [...p, { id: `j-${p.length + 1}-${p.reduce((n, j) => n + j.id.length, 0)}`, name: `Judge ${p.length + 1}` }]);
  const removeJudge = (idx: number) => setJudges((p) => p.filter((_, i) => i !== idx));
  const [passThreshold, setPassThreshold] = useState<string>(
    initial?.passThreshold !== undefined ? String(Math.round(initial.passThreshold * 100)) : "",
  );
  const [cases, setCases] = useState<EvalCase[]>(initial?.cases?.length ? initial.cases : [freshCase(0)]);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [genBusy, setGenBusy] = useState(false);
  const [genCount, setGenCount] = useState("5");
  const [genFocus, setGenFocus] = useState("");

  const updCase = (idx: number, patch: Partial<EvalCase>) =>
    setCases((p) => p.map((c, i) => (i === idx ? { ...c, ...patch } : c)));

  const generate = async () => {
    if (!agentName) return setErr("Pick an agent first — cases are generated from it.");
    setGenBusy(true);
    setErr(null);
    try {
      const n = Math.max(1, Math.min(20, Number(genCount) || 5));
      const gen = await api.evals.generateCases(agentName, n, genFocus.trim() || undefined);
      // Drop the empty starter case, then append the generated ones.
      setCases((p) => [...p.filter((c) => c.prompt.trim()), ...gen]);
    } catch (e) {
      setErr(String(e));
    } finally {
      setGenBusy(false);
    }
  };

  const save = async () => {
    if (!name.trim()) return setErr("Name is required");
    if (!agentName) return setErr("Pick an agent");
    setSaving(true);
    setErr(null);
    const body: EvalSuiteInput = {
      name: name.trim(),
      description: description.trim() || undefined,
      agentName,
      scorers,
      judges: judges.map((j) => ({
        id: j.id,
        name: j.name.trim() || "Judge",
        ...(j.rubric?.trim() ? { rubric: j.rubric.trim() } : {}),
        ...(j.model?.trim() ? { model: j.model.trim() } : {}),
        ...(j.passThreshold !== undefined && !Number.isNaN(j.passThreshold)
          ? { passThreshold: Math.max(0, Math.min(1, j.passThreshold)) }
          : {}),
      })),
      passThreshold: passThreshold.trim() ? Math.max(0, Math.min(100, Number(passThreshold))) / 100 : undefined,
      cases: cases.filter((c) => c.prompt.trim()),
    };
    try {
      const saved = initial ? await api.evals.updateSuite(initial._id, body) : await api.evals.createSuite(body);
      onSaved(saved);
    } catch (e) {
      setErr(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="p-6 max-w-3xl">
      <h2 className="text-lg font-semibold mb-4">{initial ? "Edit suite" : "New simulation suite"}</h2>
      {err && <div className="mb-3 text-sm text-destructive">{err}</div>}

      <Section title="Suite">
        <Field label="Name">
          <input value={name} onChange={(e) => setName(e.target.value)} className={inputCls} placeholder="e.g. Customer-support smoke" />
        </Field>
        <Field label="Description">
          <input value={description} onChange={(e) => setDescription(e.target.value)} className={inputCls} />
        </Field>
        <Field label="Agent">
          <select value={agentName} onChange={(e) => setAgentName(e.target.value)} className={inputCls}>
            <option value="">— select agent —</option>
            {agents.map((a) => (
              <option key={a.name} value={a.name}>{a.label || a.name}</option>
            ))}
          </select>
        </Field>
      </Section>

      <Section title="Scorers">
        {(Object.keys(SCORER_LABEL) as (keyof ScorerConfig)[]).map((k) => (
          <div key={k} className="flex items-center justify-between">
            <span className="text-sm">{SCORER_LABEL[k]}</span>
            <Toggle checked={scorers[k]} onChange={(v) => setScorers((p) => ({ ...p, [k]: v }))} />
          </div>
        ))}
        <Field label="Pass gate % (optional)">
          <input value={passThreshold} onChange={(e) => setPassThreshold(e.target.value)} className={inputCls} placeholder="e.g. 80 — run is green only if pass-rate ≥ this" />
        </Field>
      </Section>

      {scorers.taskSuccess && (
        <Section
          title="Judges (LLM-as-a-judge)"
          right={<button onClick={addJudge} className="text-xs text-primary hover:underline">+ Add judge</button>}
        >
          <p className="text-[11px] text-muted-foreground">
            Each judge scores every case from the agent's <span className="font-medium">whole trace</span> (tool calls + steps) and output, returns a 0–1 score, and is shown separately in results. Custom rubric vars:{" "}
            <code className="font-mono">{"{{prompt}} {{criteria}} {{output}} {{trace}} {{tools}} {{golden}}"}</code>.
          </p>
          {judges.map((j, i) => (
            <div key={j.id} className="rounded border border-border bg-card/60 p-3 space-y-2">
              <div className="flex gap-2 items-center">
                <input value={j.name} onChange={(e) => updJudge(i, { name: e.target.value })} className={cn(inputCls, "flex-1")} placeholder="Judge name (e.g. Correctness, Safety, Tone)" />
                <input value={j.model ?? ""} onChange={(e) => updJudge(i, { model: e.target.value || undefined })} className={cn(inputCls, "w-40")} placeholder="model (optional)" />
                <input
                  value={j.passThreshold ?? ""}
                  onChange={(e) => updJudge(i, { passThreshold: e.target.value ? Number(e.target.value) : undefined })}
                  className={cn(inputCls, "w-16 text-center")}
                  placeholder="0.5"
                  title="pass threshold 0–1"
                />
                {judges.length > 1 && (
                  <button onClick={() => removeJudge(i)} className="shrink-0 text-destructive hover:text-destructive/80" title="Remove judge">
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
              <textarea
                value={j.rubric ?? ""}
                onChange={(e) => updJudge(i, { rubric: e.target.value || undefined })}
                rows={3}
                className={cn(inputCls, "font-mono text-xs")}
                placeholder="Custom rubric (optional) — defaults to grading task success from the trace + output"
              />
            </div>
          ))}
        </Section>
      )}

      <Section title="Cases" right={<button onClick={() => setCases((p) => [...p, freshCase(p.length)])} className="text-xs text-primary hover:underline">+ Add case</button>}>
        <div className="flex items-end gap-2 rounded border border-dashed border-border bg-muted/30 p-2 mb-1">
          <div className="flex-1 min-w-0">
            <label className="block text-[10px] uppercase tracking-wide text-muted-foreground mb-1">Generate from agent</label>
            <input value={genFocus} onChange={(e) => setGenFocus(e.target.value)} className={inputCls} placeholder="optional focus — e.g. 'edge cases', 'guardrails / safety'" />
          </div>
          <input value={genCount} onChange={(e) => setGenCount(e.target.value)} className={cn(inputCls, "w-14 shrink-0 text-center")} title="number of cases" />
          <button
            onClick={generate}
            disabled={genBusy || !agentName}
            title={agentName ? "Probe the agent + synthesize cases" : "Pick an agent first"}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-primary text-primary-foreground text-sm hover:bg-primary/90 disabled:opacity-50 shrink-0"
          >
            {genBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
            {genBusy ? "Generating…" : "Generate"}
          </button>
        </div>
        {cases.map((c, idx) => (
          <div key={c.id} className="rounded border border-border bg-card/60 p-3 space-y-2">
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">Case {idx + 1}</span>
              {cases.length > 1 && (
                <button onClick={() => setCases((p) => p.filter((_, i) => i !== idx))} className="ml-auto text-xs text-destructive hover:text-destructive/80">Remove</button>
              )}
            </div>
            <textarea value={c.prompt} onChange={(e) => updCase(idx, { prompt: e.target.value })} rows={2} className={inputCls} placeholder="Prompt / task sent to the agent" />
            {scorers.taskSuccess && (
              <textarea value={c.criteria ?? ""} onChange={(e) => updCase(idx, { criteria: e.target.value })} rows={1} className={inputCls} placeholder="Success criteria for the LLM judge" />
            )}
            {scorers.golden && (
              <div className="flex gap-2">
                <select
                  value={c.golden?.mode ?? "contains"}
                  onChange={(e) => updCase(idx, { golden: { mode: e.target.value as "exact" | "contains" | "regex", value: c.golden?.value ?? "" } })}
                  className={cn(inputCls, "w-32 shrink-0")}
                >
                  <option value="contains">contains</option>
                  <option value="exact">exact</option>
                  <option value="regex">regex</option>
                </select>
                <input value={c.golden?.value ?? ""} onChange={(e) => updCase(idx, { golden: { mode: c.golden?.mode ?? "contains", value: e.target.value } })} className={inputCls} placeholder="expected output" />
              </div>
            )}
            {scorers.toolCompliance && (
              <div className="flex gap-2">
                <input value={(c.expectedTools ?? []).join(", ")} onChange={(e) => updCase(idx, { expectedTools: splitTools(e.target.value) })} className={inputCls} placeholder="expected tools (comma-sep)" />
                <input value={(c.forbiddenTools ?? []).join(", ")} onChange={(e) => updCase(idx, { forbiddenTools: splitTools(e.target.value) })} className={inputCls} placeholder="forbidden tools (e.g. Bash)" />
              </div>
            )}
            {scorers.nfr && (
              <div className="flex gap-2">
                <input value={c.maxCostUsd ?? ""} onChange={(e) => updCase(idx, { maxCostUsd: e.target.value ? Number(e.target.value) : undefined })} className={inputCls} placeholder="max cost $ (e.g. 0.05)" />
                <input value={c.maxLatencyMs ?? ""} onChange={(e) => updCase(idx, { maxLatencyMs: e.target.value ? Number(e.target.value) : undefined })} className={inputCls} placeholder="max latency ms (e.g. 15000)" />
              </div>
            )}
          </div>
        ))}
      </Section>

      <div className="flex items-center gap-2 mt-5">
        {canWrite && (
          <button onClick={save} disabled={saving} className="px-4 py-1.5 rounded bg-primary text-primary-foreground text-sm hover:bg-primary/90 disabled:opacity-50">
            {saving ? "Saving…" : initial ? "Save changes" : "Create suite"}
          </button>
        )}
        <button onClick={onCancel} className="px-4 py-1.5 rounded border border-border text-sm hover:bg-muted">{canWrite ? "Cancel" : "Close"}</button>
      </div>
    </div>
  );
}

// ── small shared bits ───────────────────────────────────────────────────────
const inputCls = "w-full bg-background border border-border rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring";

function splitTools(v: string): string[] {
  return v.split(",").map((t) => t.trim()).filter(Boolean);
}

function Section({ title, children, right }: { title: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="mb-5 rounded-lg border border-border bg-card p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold">{title}</h3>
        {right}
      </div>
      <div className="space-y-3">{children}</div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-[11px] uppercase tracking-wide text-muted-foreground mb-1">{label}</label>
      {children}
    </div>
  );
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={cn("h-5 w-9 relative rounded-full transition shrink-0", checked ? "bg-primary" : "bg-border")}
    >
      <span className={cn("h-4 w-4 absolute top-0.5 bg-background rounded-full transition", checked ? "left-4" : "left-0.5")} />
    </button>
  );
}

function ScoreBadge({ s }: { s: ScoreResult }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] border",
        s.passed ? "border-emerald-500/40 text-emerald-500 bg-emerald-500/10" : "border-destructive/40 text-destructive bg-destructive/10",
      )}
      title={s.detail}
    >
      {s.passed ? "✓" : "✕"} {scoreLabel(s)}
    </span>
  );
}

function StatusDot({ status, large }: { status: EvalRun["status"]; large?: boolean }) {
  const sz = large ? "h-3 w-3" : "h-2 w-2";
  if (status === "running") return <Loader2 className={cn(large ? "h-5 w-5" : "h-3.5 w-3.5", "animate-spin text-primary shrink-0")} />;
  const color = status === "completed" ? "bg-emerald-500" : "bg-destructive";
  return <span className={cn(sz, "rounded-full shrink-0", color)} />;
}

function PassPill({ summary, status }: { summary: EvalRun["summary"]; status: EvalRun["status"] }) {
  if (status === "running") return <span className="text-[11px] text-muted-foreground">running…</span>;
  const pct = (summary.passRate * 100).toFixed(0);
  return (
    <span className={cn("text-[11px] font-mono shrink-0", summary.passRate >= 1 ? "text-emerald-500" : summary.passRate > 0 ? "text-amber-500" : "text-destructive")}>
      {summary.passed}/{summary.total} · {pct}%
    </span>
  );
}
