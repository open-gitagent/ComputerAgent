import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { obsApi, type SpanDetail, type TraceDetail as TraceDetailData } from "../../obs-api.ts";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "../ui/sheet.tsx";
import { Skeleton } from "../ui/skeleton.tsx";
import { Badge } from "../ui/badge.tsx";
import { cn } from "../../lib/cn.ts";

const GANTT_COL_WIDTH = 360;
const RULER_TICKS = [0, 0.25, 0.5, 0.75, 1] as const;

export function TraceDetail({ traceId, onClose }: { traceId: string; onClose: () => void }) {
  const [data, setData] = useState<TraceDetailData | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setData(null);
    setErr(null);
    obsApi.trace(traceId).then(setData).catch((e) => setErr(String(e)));
  }, [traceId]);

  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        side="right"
        className="!w-[min(92vw,920px)] !max-w-none sm:!max-w-none p-0 flex flex-col"
      >
        <SheetHeader>
          <SheetTitle className="text-xs uppercase tracking-wider text-muted-foreground font-medium">
            Trace
          </SheetTitle>
          <SheetDescription className="font-mono text-[11px] break-all text-foreground">
            {traceId}
          </SheetDescription>
        </SheetHeader>
        <div className="flex-1 overflow-y-auto">
          {err && <div className="p-5 text-sm text-destructive">{err}</div>}
          {!err && !data && (
            <div className="p-5 space-y-2">
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-2/3" />
              <Skeleton className="h-10 w-3/4" />
            </div>
          )}
          {data && <SpanTree data={data} />}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function buildTree(spans: SpanDetail[]): { node: SpanDetail; depth: number }[] {
  const ids = new Set(spans.map((s) => s.SpanId));
  const children = new Map<string, SpanDetail[]>();
  const roots: SpanDetail[] = [];
  for (const s of spans) {
    if (s.ParentSpanId && ids.has(s.ParentSpanId)) {
      const arr = children.get(s.ParentSpanId) ?? [];
      arr.push(s);
      children.set(s.ParentSpanId, arr);
    } else {
      roots.push(s);
    }
  }
  const out: { node: SpanDetail; depth: number }[] = [];
  const walk = (node: SpanDetail, depth: number) => {
    out.push({ node, depth });
    const kids = (children.get(node.SpanId) ?? []).slice().sort((a, b) => a.ts_ms - b.ts_ms);
    for (const k of kids) walk(k, depth + 1);
  };
  for (const r of roots.sort((a, b) => a.ts_ms - b.ts_ms)) walk(r, 0);
  return out;
}

function fmtDuration(ms: number): string {
  if (ms < 1) return `${(ms * 1000).toFixed(0)}µs`;
  if (ms < 1000) return `${ms.toFixed(ms < 10 ? 1 : 0)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function SpanTree({ data }: { data: TraceDetailData }) {
  const tree = useMemo(() => buildTree(data.spans), [data]);

  // Time window = root start → latest span end.
  const rootTs = data.root.ts_ms;
  const totalSpan = Math.max(
    1,
    ...data.spans.map((s) => s.ts_ms + s.duration_ms - rootTs),
  );

  const cost = data.spans.reduce(
    (s, sp) => s + (parseFloat(sp.SpanAttributes["computeragent.usage.cost_usd"] ?? "0") || 0),
    0,
  );
  const inTok = data.spans.reduce(
    (s, sp) => s + (parseInt(sp.SpanAttributes["gen_ai.usage.input_tokens"] ?? "0", 10) || 0),
    0,
  );
  const outTok = data.spans.reduce(
    (s, sp) => s + (parseInt(sp.SpanAttributes["gen_ai.usage.output_tokens"] ?? "0", 10) || 0),
    0,
  );

  return (
    <div>
      <div className="px-5 py-3 border-b border-border grid grid-cols-4 gap-3">
        <Stat label="Spans" value={data.spans.length} />
        <Stat label="Duration" value={fmtDuration(totalSpan)} />
        <Stat
          label="Tokens"
          value={`${inTok.toLocaleString()} ↓ / ${outTok.toLocaleString()} ↑`}
        />
        <Stat label="Cost" value={cost > 0 ? `$${cost.toFixed(4)}` : "—"} />
      </div>

      <RulerHeader totalSpan={totalSpan} />

      <div role="tree" className="divide-y divide-border/60">
        {tree.map(({ node, depth }) => (
          <SpanRow
            key={node.SpanId}
            node={node}
            depth={depth}
            rootTs={rootTs}
            totalSpan={totalSpan}
          />
        ))}
      </div>
    </div>
  );
}

function RulerHeader({ totalSpan }: { totalSpan: number }) {
  return (
    <div
      className="sticky top-0 z-10 grid bg-background/95 backdrop-blur border-b border-border"
      style={{ gridTemplateColumns: `minmax(0,1fr) ${GANTT_COL_WIDTH}px` }}
    >
      <div className="px-5 py-2 text-[10px] uppercase tracking-wider text-muted-foreground">
        Span
      </div>
      <div className="relative px-3 py-2">
        <div className="relative h-4">
          {RULER_TICKS.map((t, i) => {
            const isFirst = i === 0;
            const isLast = i === RULER_TICKS.length - 1;
            const style: CSSProperties = isFirst
              ? { left: 0 }
              : isLast
                ? { right: 0 }
                : { left: `${t * 100}%`, transform: "translateX(-50%)" };
            return (
              <span
                key={t}
                className="absolute top-0 text-[10px] tabular-nums text-muted-foreground"
                style={style}
              >
                {fmtDuration(totalSpan * t)}
              </span>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="text-sm text-foreground mt-0.5 tabular-nums">{value}</div>
    </div>
  );
}

function SpanRow({
  node,
  depth,
  rootTs,
  totalSpan,
}: {
  node: SpanDetail;
  depth: number;
  rootTs: number;
  totalSpan: number;
}) {
  const [open, setOpen] = useState(false);
  const startMs = node.ts_ms - rootTs;
  // Standard L→R gantt: bar starts at startPct from left, extends rightward by widthPct.
  const startPct = Math.max(0, Math.min(100, (startMs / totalSpan) * 100));
  const widthPct = Math.max(0.4, Math.min(100 - startPct, (node.duration_ms / totalSpan) * 100));
  const endPct = startPct + widthPct;
  const errored = node.StatusCode === "Error" || node.StatusCode === "STATUS_CODE_ERROR";
  // If the bar already reaches near the far right, flip the duration label to the LEFT of the bar.
  const labelOnLeft = endPct > 80;

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "w-full grid items-center text-left hover:bg-muted/40 transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
        )}
        style={{ gridTemplateColumns: `minmax(0,1fr) ${GANTT_COL_WIDTH}px` }}
      >
        {/* Tree column */}
        <div className="flex items-center gap-2 px-5 py-2 min-w-0">
          <span
            className="flex items-center gap-2 min-w-0 flex-1"
            style={{ paddingLeft: `${depth * 14}px` }}
          >
            {open ? (
              <ChevronDown className="h-3 w-3 text-muted-foreground shrink-0" />
            ) : (
              <ChevronRight className="h-3 w-3 text-muted-foreground shrink-0" />
            )}
            <span className="text-sm text-foreground truncate">{node.SpanName}</span>
            {errored && (
              <Badge variant="destructive" className="text-[9px] shrink-0">
                error
              </Badge>
            )}
          </span>
        </div>

        {/* Gantt column */}
        <div className="px-3 py-3">
          <div className="relative h-2.5 bg-muted/30 rounded-sm">
            {RULER_TICKS.map((t) => (
              <div
                key={t}
                className="absolute inset-y-0 w-px bg-border/70"
                style={{ left: `calc(${t * 100}% - 0.5px)` }}
              />
            ))}
            <div
              title={`start: ${fmtDuration(startMs)} · dur: ${fmtDuration(node.duration_ms)}`}
              className="absolute inset-y-0 rounded-sm"
              style={{
                left: `${startPct}%`,
                width: `${widthPct}%`,
                minWidth: 3,
                backgroundColor: errored ? "hsl(var(--destructive))" : "hsl(var(--primary))",
              }}
            />
            <div
              className="absolute top-1/2 -translate-y-1/2 text-[10px] tabular-nums text-muted-foreground whitespace-nowrap pointer-events-none"
              style={
                labelOnLeft
                  ? { right: `${100 - startPct}%`, paddingRight: 6 }
                  : { left: `${endPct}%`, paddingLeft: 6 }
              }
            >
              {fmtDuration(node.duration_ms)}
            </div>
          </div>
        </div>
      </button>
      {open && <SpanAttributes node={node} />}
    </div>
  );
}

function SpanAttributes({ node }: { node: SpanDetail }) {
  const entries = Object.entries(node.SpanAttributes).sort(([a], [b]) => a.localeCompare(b));
  return (
    <div className="px-5 py-3 bg-muted/40 border-t border-border text-xs">
      <dl className="grid grid-cols-[160px_1fr] gap-x-3 gap-y-1">
        <dt className="text-muted-foreground">span_id</dt>
        <dd className="font-mono text-foreground/90">{node.SpanId}</dd>
        <dt className="text-muted-foreground">service</dt>
        <dd className="text-foreground/90">{node.ServiceName}</dd>
        <dt className="text-muted-foreground">kind</dt>
        <dd className="text-foreground/90">{node.SpanKind}</dd>
        <dt className="text-muted-foreground">status</dt>
        <dd className="text-foreground/90">
          {node.StatusCode}
          {node.StatusMessage ? ` · ${node.StatusMessage}` : ""}
        </dd>
      </dl>
      {entries.length > 0 && (
        <>
          <div className="mt-3 text-[10px] uppercase tracking-wider text-muted-foreground">
            Attributes
          </div>
          <dl className="grid grid-cols-[200px_1fr] gap-x-3 gap-y-0.5 mt-1">
            {entries.map(([k, v]) => (
              <Row key={k} k={k} v={v} />
            ))}
          </dl>
        </>
      )}
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <>
      <dt className="text-muted-foreground font-mono break-all">{k}</dt>
      <dd className="text-foreground/90 break-words whitespace-pre-wrap">{v}</dd>
    </>
  );
}
