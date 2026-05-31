import { Search } from "lucide-react";
import type { TraceSummary } from "../../obs-api.ts";
import { Badge } from "../ui/badge.tsx";
import { DataTable, type Column } from "../composite/DataTable.tsx";
import { EmptyState } from "../composite/EmptyState.tsx";

// The collector emits span names as "<operation> <subject>" (e.g.
// "invoke_agent otel-haiku-bot", "chat claude-haiku-..."). We strip the
// operation prefix in the Trace column so the row shows only the meaningful
// subject — operation type is already implied by the Agent / Model columns.
function spanSubject(spanName: string, op: string): string {
  if (op && spanName.startsWith(`${op} `)) return spanName.slice(op.length + 1);
  return spanName;
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function timeAgo(ms: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function TraceList({
  traces,
  onSelect,
  loading,
  err,
}: {
  traces: TraceSummary[];
  onSelect: (t: TraceSummary) => void;
  loading: boolean;
  err: string | null;
}) {
  if (err) return <div className="p-6 text-sm text-destructive">{err}</div>;

  const columns: Column<TraceSummary>[] = [
    {
      key: "trace",
      header: "Trace",
      cell: (r) => (
        <div className="min-w-0">
          <div className="text-sm text-foreground truncate">
            {spanSubject(r.root_span_name, r.root_operation)}
          </div>
          <div className="text-[10px] text-muted-foreground font-mono truncate mt-0.5">
            {r.TraceId.slice(0, 16)}…
          </div>
        </div>
      ),
    },
    {
      key: "agent",
      header: "Agent",
      cell: (r) =>
        r.agent ? (
          <span className="text-xs text-muted-foreground">{r.agent}</span>
        ) : (
          <span className="text-muted-foreground/50">—</span>
        ),
    },
    {
      key: "model",
      header: "Model",
      cell: (r) =>
        r.model ? (
          <span className="text-xs text-muted-foreground">{r.model}</span>
        ) : (
          <span className="text-muted-foreground/50">—</span>
        ),
    },
    {
      key: "spans",
      header: "Spans",
      align: "right",
      sortBy: (r) => r.span_count,
      cell: (r) => <span className="text-xs tabular-nums">{r.span_count}</span>,
    },
    {
      key: "duration",
      header: "Dur",
      align: "right",
      sortBy: (r) => r.duration_ms,
      cell: (r) => <span className="text-xs tabular-nums">{fmtDuration(r.duration_ms)}</span>,
    },
    {
      key: "tokens",
      header: "Tokens",
      align: "right",
      sortBy: (r) => r.input_tokens + r.output_tokens,
      cell: (r) =>
        r.input_tokens || r.output_tokens ? (
          <span className="text-xs text-muted-foreground tabular-nums">
            <span className="text-muted-foreground/70">↓</span>
            {r.input_tokens.toLocaleString()}{" "}
            <span className="text-muted-foreground/70">↑</span>
            {r.output_tokens.toLocaleString()}
          </span>
        ) : (
          <span className="text-muted-foreground/50">—</span>
        ),
    },
    {
      key: "cost",
      header: "Cost",
      align: "right",
      sortBy: (r) => r.cost_usd,
      cell: (r) =>
        r.cost_usd > 0 ? (
          <span className="text-xs tabular-nums">${r.cost_usd.toFixed(4)}</span>
        ) : (
          <span className="text-muted-foreground/50">—</span>
        ),
    },
    {
      key: "status",
      header: "Status",
      cell: (r) =>
        r.error_count > 0 ? (
          <Badge variant="destructive" className="text-[10px]">
            {r.error_count} error{r.error_count !== 1 ? "s" : ""}
          </Badge>
        ) : (
          <Badge variant="success" className="text-[10px]">
            ok
          </Badge>
        ),
    },
    {
      key: "time",
      header: "Time",
      align: "right",
      sortBy: (r) => r.started_at_ms,
      cell: (r) => (
        <div className="text-xs whitespace-nowrap text-right">
          <div className="text-foreground">{timeAgo(r.started_at_ms)}</div>
          <div className="text-[10px] text-muted-foreground">{new Date(r.started_at_ms).toLocaleTimeString()}</div>
        </div>
      ),
    },
  ];

  return (
    <DataTable
      columns={columns}
      rows={traces}
      loading={loading}
      onRowClick={onSelect}
      rowKey={(r) => r.TraceId}
      empty={
        <EmptyState
          icon={Search}
          title="No traces match"
          body="Try widening the time range or clearing filters."
        />
      }
    />
  );
}
