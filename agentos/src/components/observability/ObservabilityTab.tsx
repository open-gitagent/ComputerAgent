import { useEffect, useState } from "react";
import { obsApi, type Filter, type TraceSummary } from "../../obs-api.ts";
import { QueryBuilder } from "./QueryBuilder.tsx";
import { TraceList } from "./TraceList.tsx";
import { TraceDetail } from "./TraceDetail.tsx";
import { Dashboard } from "./Dashboard.tsx";
import { DateRangePicker, type Range } from "./DateRangePicker.tsx";
import { PageHeader } from "../composite/PageHeader.tsx";
import { StatusDot } from "../composite/StatusDot.tsx";
import { Tabs, TabsList, TabsTrigger } from "../ui/tabs.tsx";

type SubTab = "dashboard" | "explorer";

export function ObservabilityTab() {
  const [sub, setSub] = useState<SubTab>("dashboard");
  const [range, setRange] = useState<Range>({ from: "now-24h", to: "now" });
  const [filters, setFilters] = useState<Filter[]>([]);
  const [traces, setTraces] = useState<TraceSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [openTrace, setOpenTrace] = useState<string | null>(null);
  const [chOk, setChOk] = useState<boolean | null>(null);

  useEffect(() => {
    obsApi.health()
      .then((h) => setChOk(h.clickhouse === "up"))
      .catch(() => setChOk(false));
  }, []);

  const run = () => {
    setLoading(true);
    obsApi.search({ filters, from: range.from, to: range.to, limit: 200 })
      .then((t) => { setTraces(t); setErr(null); })
      .catch((e) => setErr(String(e)))
      .finally(() => setLoading(false));
  };

  // Auto-run when explorer is active and inputs change
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
                <TabsTrigger value="explorer">Explorer</TabsTrigger>
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
        </div>
      )}

      {openTrace && <TraceDetail traceId={openTrace} onClose={() => setOpenTrace(null)} />}
    </div>
  );
}
