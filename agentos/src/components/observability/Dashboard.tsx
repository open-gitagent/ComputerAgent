import { useEffect, useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  Cell,
  ResponsiveContainer as _RC,  // ensure recharts side-effects load
  XAxis,
  YAxis,
} from "recharts";
import { obsApi, type DashboardData } from "../../obs-api.ts";
import { KpiCard } from "../composite/KpiCard.tsx";
import { Card } from "../ui/card.tsx";
import { Skeleton } from "../ui/skeleton.tsx";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "../ui/chart.tsx";

// Silence unused import — present so recharts injects its global ResponsiveContainer
// reference even when ChartContainer (which uses it internally) is the only call site.
void _RC;

export function Dashboard({
  agent,
  group,
  actor,
  from,
  to,
}: {
  agent?: string;
  group?: string;
  actor?: string;
  from: string;
  to: string;
}) {
  const [data, setData] = useState<DashboardData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    obsApi
      .dashboard({ agent, group, actor, from, to })
      .then((d) => {
        setData(d);
        setErr(null);
      })
      .catch((e) => setErr(String(e)))
      .finally(() => setLoading(false));
  }, [agent, group, actor, from, to]);

  if (err) return <div className="p-6 text-sm text-destructive">{err}</div>;
  if (loading || !data) {
    return (
      <div className="px-6 py-4 space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-44 w-full" />
          ))}
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Skeleton className="h-64 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  return (
    <div className="px-6 py-4 space-y-4">
      {/* KPI strip */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard label="Cost" value={`$${data.cost.total.toFixed(4)}`} subtitle="last window">
          {data.cost.byModel.length > 0 && <ByModelList rows={data.cost.byModel.map((r) => ({ label: r.model || "(no model)", value: `$${r.cost.toFixed(4)}`, raw: r.cost }))} />}
        </KpiCard>

        <KpiCard
          label="Tokens"
          value={`${(data.tokens.input + data.tokens.output).toLocaleString()}`}
          subtitle={`${data.tokens.input.toLocaleString()} in / ${data.tokens.output.toLocaleString()} out`}
        >
          {data.tokens.byModel.length > 0 && (
            <ByModelList
              rows={data.tokens.byModel.map((r) => ({
                label: r.model || "(no model)",
                value: `${(r.input + r.output).toLocaleString()}`,
                raw: r.input + r.output,
              }))}
            />
          )}
        </KpiCard>

        <KpiCard
          label="Latency (p95)"
          value={fmtMs(data.latency.p95)}
          subtitle={`${data.latency.count.toLocaleString()} spans · p50 ${fmtMs(data.latency.p50)} · p99 ${fmtMs(data.latency.p99)}`}
        >
          {data.latency.byOperation.length > 0 && (
            <ByModelList
              rows={data.latency.byOperation.map((r) => ({
                label: `${r.operation} (${r.count.toLocaleString()})`,
                value: `p50 ${fmtMs(r.p50)} · p95 ${fmtMs(r.p95)}`,
                raw: r.p95,
              }))}
            />
          )}
        </KpiCard>

        <KpiCard
          label="Error rate"
          value={`${(data.errors.rate * 100).toFixed(2)}%`}
          subtitle={`${data.errors.total.toLocaleString()} of ${data.errors.sampleSize.toLocaleString()}`}
          delta={
            data.errors.rate > 0.01
              ? { value: "high", trend: "down" }
              : { value: "stable", trend: "neutral" }
          }
        />
      </div>

      {/* Trends */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <TrendCard
          title="Throughput"
          subtitle={`spans / ${fmtInterval(data.intervalSec)}`}
          data={data.trends}
          dataKey="spans"
          color="hsl(var(--primary))"
          formatter={(v) => v.toLocaleString()}
        />
        <TrendCard
          title="Cost over time"
          subtitle={`USD / ${fmtInterval(data.intervalSec)}`}
          data={data.trends}
          dataKey="cost"
          color="hsl(38 92% 55%)"
          formatter={(v) => `$${v.toFixed(4)}`}
        />
        <TrendCard
          title="p95 latency"
          subtitle={`ms / ${fmtInterval(data.intervalSec)}`}
          data={data.trends}
          dataKey="p95Ms"
          color="hsl(199 89% 60%)"
          formatter={(v) => fmtMs(v)}
        />
        <TrendCard
          title="Errors"
          subtitle={`count / ${fmtInterval(data.intervalSec)}`}
          data={data.trends}
          dataKey="errors"
          color="hsl(var(--destructive))"
          formatter={(v) => v.toLocaleString()}
        />
      </div>

      {/* Latency distribution */}
      <LatencyHistogram histogram={data.latencyHistogram} />
    </div>
  );
}

function TrendCard({
  title,
  subtitle,
  data,
  dataKey,
  color,
  formatter,
}: {
  title: string;
  subtitle: string;
  data: DashboardData["trends"];
  dataKey: "spans" | "cost" | "p95Ms" | "errors" | "inputTokens" | "outputTokens";
  color: string;
  formatter: (v: number) => string;
}) {
  const config: ChartConfig = useMemo(
    () => ({ [dataKey]: { label: title, color } }),
    [title, color, dataKey],
  );

  // Pretty-formatted time label per point.
  const points = useMemo(
    () =>
      data.map((d) => ({
        ...d,
        timeLabel: new Date(d.t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      })),
    [data],
  );

  return (
    <Card className="p-4">
      <div className="flex items-baseline justify-between mb-3">
        <div>
          <div className="text-sm font-medium text-foreground">{title}</div>
          <div className="text-[11px] text-muted-foreground mt-0.5">{subtitle}</div>
        </div>
      </div>
      {data.length === 0 ? (
        <div className="text-xs text-muted-foreground py-10 text-center">No data in this window.</div>
      ) : (
        <ChartContainer config={config} className="h-44 aspect-auto w-full">
          <AreaChart data={points} margin={{ top: 5, right: 5, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id={`gradient-${dataKey}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={color} stopOpacity={0.5} />
                <stop offset="95%" stopColor={color} stopOpacity={0} />
              </linearGradient>
            </defs>
            <XAxis
              dataKey="timeLabel"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              fontSize={10}
              minTickGap={20}
            />
            <YAxis
              tickLine={false}
              axisLine={false}
              fontSize={10}
              width={48}
              tickFormatter={(v: unknown) => (typeof v === "number" ? compactNum(v) : String(v ?? ""))}
            />
            <ChartTooltip
              cursor={{ stroke: "hsl(var(--border))", strokeDasharray: "3 3" }}
              content={
                <ChartTooltipContent
                  formatter={(v) => (typeof v === "number" ? formatter(v) : "")}
                  labelFormatter={(_, payload) => {
                    const t = (payload?.[0] as { payload?: { t?: string } })?.payload?.t;
                    return t ? new Date(t).toLocaleString() : "";
                  }}
                />
              }
            />
            <Area
              type="monotone"
              dataKey={dataKey}
              stroke={color}
              strokeWidth={1.5}
              fill={`url(#gradient-${dataKey})`}
              isAnimationActive={false}
            />
          </AreaChart>
        </ChartContainer>
      )}
    </Card>
  );
}

function LatencyHistogram({ histogram }: { histogram: DashboardData["latencyHistogram"] }) {
  const total = histogram.reduce((s, r) => s + r.count, 0);
  const config: ChartConfig = useMemo(
    () => ({ count: { label: "Spans", color: "hsl(var(--primary))" } }),
    [],
  );

  return (
    <Card className="p-4">
      <div className="flex items-baseline justify-between mb-3">
        <div>
          <div className="text-sm font-medium text-foreground">Latency distribution</div>
          <div className="text-[11px] text-muted-foreground mt-0.5">
            {total.toLocaleString()} spans · bucketed by duration
          </div>
        </div>
      </div>
      {histogram.length === 0 ? (
        <div className="text-xs text-muted-foreground py-10 text-center">No data in this window.</div>
      ) : (
        <ChartContainer config={config} className="h-52 aspect-auto w-full">
          <BarChart data={histogram} margin={{ top: 5, right: 5, left: 0, bottom: 0 }}>
            <XAxis dataKey="bucket" tickLine={false} axisLine={false} tickMargin={8} fontSize={10} />
            <YAxis
              tickLine={false}
              axisLine={false}
              fontSize={10}
              width={40}
              tickFormatter={(v: unknown) => (typeof v === "number" ? compactNum(v) : String(v ?? ""))}
            />
            <ChartTooltip
              cursor={{ fill: "hsl(var(--muted) / 0.4)" }}
              content={
                <ChartTooltipContent
                  formatter={(v) => (typeof v === "number" ? `${v.toLocaleString()} spans` : "")}
                />
              }
            />
            <Bar dataKey="count" radius={[4, 4, 0, 0]} isAnimationActive={false}>
              {histogram.map((_, i) => (
                <Cell key={i} fill="hsl(var(--primary))" />
              ))}
            </Bar>
          </BarChart>
        </ChartContainer>
      )}
    </Card>
  );
}

function ByModelList({ rows }: { rows: Array<{ label: string; value: string; raw: number }> }) {
  const max = Math.max(...rows.map((r) => r.raw), 1e-9);
  return (
    <div className="space-y-1.5">
      {rows.map((r, i) => (
        <div key={i} className="text-xs">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-foreground/90 truncate">{r.label}</span>
            <span className="text-muted-foreground tabular-nums shrink-0">{r.value}</span>
          </div>
          <div className="h-1 rounded-full bg-muted mt-1 overflow-hidden">
            <div className="h-full bg-primary/60 rounded-full" style={{ width: `${Math.min(100, (r.raw / max) * 100)}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

function fmtMs(n: number): string {
  if (n < 1) return "0";
  if (n < 1000) return `${n.toFixed(0)}ms`;
  return `${(n / 1000).toFixed(2)}s`;
}

function fmtInterval(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  if (sec < 86400) return `${(sec / 3600).toFixed(1)}h`;
  return `${(sec / 86400).toFixed(1)}d`;
}

function compactNum(v: number): string {
  if (Math.abs(v) >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (Math.abs(v) >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
  if (v !== 0 && Math.abs(v) < 0.01) return v.toExponential(1);
  if (Number.isInteger(v)) return String(v);
  return v.toFixed(2);
}
