// Simulation dashboard — an observability-style overview of the Agent Simulation
// Engine. Aggregates the recent eval runs (across all suites) into KPIs, a
// pass-rate trend, per-scorer / per-judge pass rates, per-suite health, and a
// recent-runs table. All computed client-side from GET /evals/runs.

import { useEffect, useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  ResponsiveContainer as _RC, // ensure recharts side-effects load
  XAxis,
  YAxis,
} from "recharts";
import { CheckCircle2, XCircle, Loader2, RefreshCw, FlaskConical } from "lucide-react";

import { api, type EvalRun, type ScoreResult } from "../api.ts";
import { KpiCard } from "./composite/KpiCard.tsx";
import { Card } from "./ui/card.tsx";
import { Skeleton } from "./ui/skeleton.tsx";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "./ui/chart.tsx";
import { cn } from "../lib/cn.ts";

void _RC;

const SCORER_NAME: Record<ScoreResult["scorer"], string> = {
  taskSuccess: "LLM-judge",
  toolCompliance: "Tool & policy",
  golden: "Golden match",
  nfr: "NFRs",
};

export function SimDashboard({ onOpenRun }: { onOpenRun: (runId: string) => void }) {
  const [runs, setRuns] = useState<EvalRun[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [reloading, setReloading] = useState(false);

  const load = () => {
    setReloading(true);
    api.evals
      .listRuns()
      .then((r) => {
        setRuns(r);
        setErr(null);
      })
      .catch((e) => setErr(String(e)))
      .finally(() => setReloading(false));
  };
  useEffect(load, []);

  const stats = useMemo(() => (runs ? computeStats(runs) : null), [runs]);

  if (err) return <div className="p-6 text-sm text-destructive">{err}</div>;
  if (!runs || !stats) {
    return (
      <div className="px-6 py-4 space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>
        <Skeleton className="h-56 w-full" />
        <Skeleton className="h-56 w-full" />
      </div>
    );
  }

  if (runs.length === 0) {
    return (
      <div className="h-full grid place-items-center text-center">
        <div className="space-y-2">
          <FlaskConical className="h-8 w-8 text-muted-foreground mx-auto" />
          <div className="text-sm text-muted-foreground">No simulation runs yet.</div>
          <div className="text-xs text-muted-foreground">Create a suite and run it to populate the dashboard.</div>
        </div>
      </div>
    );
  }

  return (
    <div className="px-6 py-4 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-base font-semibold">Simulation overview</div>
          <div className="text-[11px] text-muted-foreground mt-0.5">
            Last {runs.length} run{runs.length === 1 ? "" : "s"} across {stats.suiteCount} suite{stats.suiteCount === 1 ? "" : "s"}
          </div>
        </div>
        <button
          onClick={load}
          className="flex items-center gap-1.5 text-xs px-2 py-1 rounded border border-border hover:bg-muted/60"
        >
          <RefreshCw className={cn("h-3 w-3", reloading && "animate-spin")} /> Refresh
        </button>
      </div>

      {/* KPI strip */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard
          label="Pass rate"
          value={`${(stats.passRate * 100).toFixed(1)}%`}
          subtitle={`${stats.casesPassed} / ${stats.casesTotal} cases passed`}
          delta={{
            value: stats.passRate >= 0.8 ? "healthy" : stats.passRate >= 0.5 ? "watch" : "low",
            trend: stats.passRate >= 0.8 ? "up" : stats.passRate >= 0.5 ? "neutral" : "down",
          }}
        />
        <KpiCard label="Runs" value={stats.runCount.toLocaleString()} subtitle={`${stats.completed} completed · ${stats.running} running · ${stats.failed} failed`} />
        <KpiCard label="Cost" value={`$${stats.totalCost.toFixed(4)}`} subtitle={`avg $${stats.avgCostPerCase.toFixed(4)} / case`} />
        <KpiCard label="Latency" value={fmtMs(stats.avgLatency)} subtitle={`avg / case · ${stats.casesTotal} sampled`} />
      </div>

      {/* Pass-rate trend */}
      <Card className="p-4">
        <div className="mb-3">
          <div className="text-sm font-medium text-foreground">Pass rate over time</div>
          <div className="text-[11px] text-muted-foreground mt-0.5">per completed run, oldest → newest</div>
        </div>
        {stats.trend.length === 0 ? (
          <div className="text-xs text-muted-foreground py-10 text-center">No completed runs yet.</div>
        ) : (
          <ChartContainer config={TREND_CONFIG} className="h-48 aspect-auto w-full">
            <AreaChart data={stats.trend} margin={{ top: 5, right: 5, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="sim-grad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.5} />
                  <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                </linearGradient>
              </defs>
              <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} fontSize={10} minTickGap={20} />
              <YAxis tickLine={false} axisLine={false} fontSize={10} width={36} domain={[0, 100]} tickFormatter={(v: unknown) => `${v}%`} />
              <ChartTooltip
                cursor={{ stroke: "hsl(var(--border))", strokeDasharray: "3 3" }}
                content={
                  <ChartTooltipContent
                    formatter={(v) => (typeof v === "number" ? `${v.toFixed(0)}% pass` : "")}
                    labelFormatter={(_, payload) => {
                      const p = (payload?.[0] as { payload?: { suiteName?: string; when?: string } })?.payload;
                      return p ? `${p.suiteName ?? ""} · ${p.when ?? ""}` : "";
                    }}
                  />
                }
              />
              <Area type="monotone" dataKey="passPct" stroke="hsl(var(--primary))" strokeWidth={1.5} fill="url(#sim-grad)" isAnimationActive={false} />
            </AreaChart>
          </ChartContainer>
        )}
      </Card>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Scorer / judge pass rates */}
        <Card className="p-4">
          <div className="mb-3">
            <div className="text-sm font-medium text-foreground">Pass rate by scorer</div>
            <div className="text-[11px] text-muted-foreground mt-0.5">each judge shown separately</div>
          </div>
          {stats.byScorer.length === 0 ? (
            <div className="text-xs text-muted-foreground py-6 text-center">No scored cases yet.</div>
          ) : (
            <RateBars rows={stats.byScorer} />
          )}
        </Card>

        {/* Suite health (latest run per suite) */}
        <Card className="p-4">
          <div className="mb-3">
            <div className="text-sm font-medium text-foreground">Suite health</div>
            <div className="text-[11px] text-muted-foreground mt-0.5">latest run per suite</div>
          </div>
          {stats.bySuite.length === 0 ? (
            <div className="text-xs text-muted-foreground py-6 text-center">No suites yet.</div>
          ) : (
            <RateBars rows={stats.bySuite} />
          )}
        </Card>
      </div>

      {/* Recent runs */}
      <Card className="p-0 overflow-hidden">
        <div className="px-4 py-3 border-b border-border">
          <div className="text-sm font-medium text-foreground">Recent runs</div>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wider text-muted-foreground border-b border-border">
              <th className="px-4 py-2 font-medium">Status</th>
              <th className="px-4 py-2 font-medium">Suite</th>
              <th className="px-4 py-2 font-medium">Agent</th>
              <th className="px-4 py-2 font-medium text-right">Pass rate</th>
              <th className="px-4 py-2 font-medium text-right">Cases</th>
              <th className="px-4 py-2 font-medium text-right">When</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr
                key={r._id}
                onClick={() => onOpenRun(r._id)}
                className="border-b border-border/60 last:border-0 hover:bg-muted/50 cursor-pointer"
              >
                <td className="px-4 py-2"><RunStatus status={r.status} /></td>
                <td className="px-4 py-2 truncate max-w-[14rem]">{r.suiteName}</td>
                <td className="px-4 py-2 text-muted-foreground">{r.agentName}</td>
                <td className="px-4 py-2 text-right tabular-nums">{(r.summary.passRate * 100).toFixed(0)}%</td>
                <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">{r.summary.passed}/{r.summary.total}</td>
                <td className="px-4 py-2 text-right text-muted-foreground text-xs">{fmtWhen(r.startedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

const TREND_CONFIG: ChartConfig = { passPct: { label: "Pass rate", color: "hsl(var(--primary))" } };

interface RateRow {
  label: string;
  pass: number;
  total: number;
}

function RateBars({ rows }: { rows: RateRow[] }) {
  return (
    <div className="space-y-2.5">
      {rows.map((r, i) => {
        const pct = r.total ? (r.pass / r.total) * 100 : 0;
        const tone = pct >= 80 ? "bg-emerald-500/70" : pct >= 50 ? "bg-amber-500/70" : "bg-destructive/70";
        return (
          <div key={i} className="text-xs">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-foreground/90 truncate">{r.label}</span>
              <span className="text-muted-foreground tabular-nums shrink-0">
                {pct.toFixed(0)}% <span className="opacity-60">({r.pass}/{r.total})</span>
              </span>
            </div>
            <div className="h-1.5 rounded-full bg-muted mt-1 overflow-hidden">
              <div className={cn("h-full rounded-full", tone)} style={{ width: `${pct}%` }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function RunStatus({ status }: { status: EvalRun["status"] }) {
  if (status === "running") return <span className="inline-flex items-center gap-1 text-amber-500"><Loader2 className="h-3.5 w-3.5 animate-spin" /> running</span>;
  if (status === "failed") return <span className="inline-flex items-center gap-1 text-destructive"><XCircle className="h-3.5 w-3.5" /> failed</span>;
  return <span className="inline-flex items-center gap-1 text-emerald-500"><CheckCircle2 className="h-3.5 w-3.5" /> done</span>;
}

// ── Aggregation ─────────────────────────────────────────────────────────────
function computeStats(runs: EvalRun[]) {
  let casesTotal = 0;
  let casesPassed = 0;
  let totalCost = 0;
  let totalLatency = 0;
  let completed = 0;
  let running = 0;
  let failed = 0;

  // scorer/judge buckets keyed by display label
  const scorerBuckets = new Map<string, RateRow>();
  const bump = (label: string, passed: boolean) => {
    const b = scorerBuckets.get(label) ?? { label, pass: 0, total: 0 };
    b.total += 1;
    if (passed) b.pass += 1;
    scorerBuckets.set(label, b);
  };

  for (const run of runs) {
    if (run.status === "completed") completed += 1;
    else if (run.status === "running") running += 1;
    else failed += 1;

    for (const c of run.results ?? []) {
      casesTotal += 1;
      if (c.passed) casesPassed += 1;
      totalCost += c.costUsd ?? 0;
      totalLatency += c.latencyMs ?? 0;
      for (const s of c.scores ?? []) {
        const label = s.scorer === "taskSuccess" ? `Judge · ${s.label ?? "default"}` : SCORER_NAME[s.scorer];
        bump(label, s.passed);
      }
    }
  }

  // Latest run per suite (runs come newest-first from the API).
  const bySuiteMap = new Map<string, RateRow>();
  for (const run of runs) {
    if (bySuiteMap.has(run.suiteId)) continue;
    if (!run.results?.length) continue;
    bySuiteMap.set(run.suiteId, { label: run.suiteName, pass: run.summary.passed, total: run.summary.total });
  }

  // Trend: completed runs, oldest → newest.
  const trend = runs
    .filter((r) => r.status === "completed")
    .slice()
    .reverse()
    .map((r) => ({
      label: fmtWhen(r.startedAt),
      when: fmtWhen(r.startedAt),
      suiteName: r.suiteName,
      passPct: Math.round(r.summary.passRate * 100),
    }));

  const suiteIds = new Set(runs.map((r) => r.suiteId));

  return {
    runCount: runs.length,
    completed,
    running,
    failed,
    suiteCount: suiteIds.size,
    casesTotal,
    casesPassed,
    passRate: casesTotal ? casesPassed / casesTotal : 0,
    totalCost,
    avgCostPerCase: casesTotal ? totalCost / casesTotal : 0,
    avgLatency: casesTotal ? totalLatency / casesTotal : 0,
    byScorer: [...scorerBuckets.values()].sort((a, b) => a.label.localeCompare(b.label)),
    bySuite: [...bySuiteMap.values()],
    trend,
  };
}

function fmtMs(n: number): string {
  if (n < 1) return "0";
  if (n < 1000) return `${n.toFixed(0)}ms`;
  return `${(n / 1000).toFixed(2)}s`;
}

function fmtWhen(iso: string | Date): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  return d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
