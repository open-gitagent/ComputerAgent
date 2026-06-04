import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { obsApi, type Filter, type TraceSummary } from "../../obs-api.ts";
import { QueryBuilder } from "./QueryBuilder.tsx";
import { TraceList } from "./TraceList.tsx";
import { TraceDetail } from "./TraceDetail.tsx";
import { Dashboard } from "./Dashboard.tsx";
import { DateRangePicker, type Range } from "./DateRangePicker.tsx";
import { PageHeader } from "../composite/PageHeader.tsx";
import { StatusDot } from "../composite/StatusDot.tsx";
import { Tabs, TabsList, TabsTrigger } from "../ui/tabs.tsx";
import { Button } from "../ui/button.tsx";

type SubTab = "dashboard" | "explorer";

// Small page size — the Traces tab loads newest-first and the user pages older
// via "Load more" (NRQL has no OFFSET, so pagination is a time cursor).
const PAGE_SIZE = 15;

export function ObservabilityTab() {
  const [sub, setSub] = useState<SubTab>("dashboard");
  const [range, setRange] = useState<Range>({ from: "now-15m", to: "now" });
  const [filters, setFilters] = useState<Filter[]>([]);
  const [traces, setTraces] = useState<TraceSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [openTrace, setOpenTrace] = useState<string | null>(null);
  const [chOk, setChOk] = useState<boolean | null>(null);

  useEffect(() => {
    obsApi.health()
      .then((h) => setChOk(h.clickhouse === "up"))
      .catch(() => setChOk(false));
  }, []);

  // Fetch the first (newest) page, replacing any existing rows.
  const run = () => {
    setLoading(true);
    obsApi
      .search({ filters, from: range.from, to: range.to, orderBy: "timestamp", orderDir: "desc", limit: PAGE_SIZE })
      .then((t) => {
        setTraces(t);
        setHasMore(t.length === PAGE_SIZE);
        setErr(null);
      })
      .catch((e) => setErr(String(e)))
      .finally(() => setLoading(false));
  };

  // Fetch the next older page using a time cursor = oldest row currently shown.
  const loadMore = () => {
    if (traces.length === 0) return;
    const before = Math.min(...traces.map((t) => Number(t.started_at_ms)));
    setLoadingMore(true);
    obsApi
      .search({ filters, from: range.from, to: range.to, orderBy: "timestamp", orderDir: "desc", limit: PAGE_SIZE, before })
      .then((page) => {
        setTraces((prev) => {
          const seen = new Set(prev.map((t) => t.TraceId));
          return [...prev, ...page.filter((t) => !seen.has(t.TraceId))];
        });
        setHasMore(page.length === PAGE_SIZE);
        setErr(null);
      })
      .catch((e) => setErr(String(e)))
      .finally(() => setLoadingMore(false));
  };

  // Auto-run (reset to page 1) when explorer is active and inputs change.
  useEffect(() => {
    if (sub === "explorer") run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range.from, range.to, sub]);

  const healthLabel = chOk == null ? "checking…" : chOk ? "ClickHouse up" : "ClickHouse down";
  const healthStatus = chOk == null ? "loading" : chOk ? "live" : "error";

  return (
    <div className="h-full flex flex-col">
      <PageHeader
        title="Observability"
        description="OTel · gen_ai semconv · ClickHouse"
        actions={
          <>
            <Tabs value={sub} onValueChange={(v) => setSub(v as SubTab)}>
              <TabsList>
                <TabsTrigger value="dashboard">Dashboard</TabsTrigger>
                <TabsTrigger value="explorer">Traces</TabsTrigger>
              </TabsList>
            </Tabs>

            <DateRangePicker value={range} onChange={setRange} />
            <StatusDot status={healthStatus} label={healthLabel} />
          </>
        }
      />

      {sub === "dashboard" ? (
        <div className="flex-1 min-h-0 overflow-auto">
          <Dashboard from={range.from} to={range.to} />
        </div>
      ) : (
        <div className="flex-1 min-h-0 flex flex-col">
          <div className="px-6 py-3">
            <QueryBuilder filters={filters} onChange={setFilters} onRun={run} />
          </div>
          <div className="flex-1 min-h-0 overflow-auto">
            <TraceList
              traces={traces}
              loading={loading}
              err={err}
              onSelect={(t) => setOpenTrace(t.TraceId)}
            />
          </div>
          {!loading && !err && traces.length > 0 && (
            <div className="px-6 py-2.5 border-t border-border flex items-center justify-between">
              <span className="text-xs text-muted-foreground tabular-nums">
                {traces.length} trace{traces.length !== 1 ? "s" : ""}
                {hasMore ? " (newest first)" : ""}
              </span>
              <div className="flex items-center gap-2">
                <Button variant="ghost" size="sm" onClick={run} className="text-xs">
                  <RefreshCw className="h-3 w-3 mr-1" />
                  Refresh
                </Button>
                {hasMore && (
                  <Button variant="outline" size="sm" onClick={loadMore} disabled={loadingMore} className="text-xs">
                    {loadingMore ? "Loading…" : "Load more"}
                  </Button>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {openTrace && <TraceDetail traceId={openTrace} onClose={() => setOpenTrace(null)} />}
    </div>
  );
}
