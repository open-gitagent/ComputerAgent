import { useEffect, useState } from "react";
import { RefreshCw, Inbox } from "lucide-react";
import { api, type LogEntry } from "../api.ts";
import { Button } from "./ui/button.tsx";
import { Badge } from "./ui/badge.tsx";
import { Skeleton } from "./ui/skeleton.tsx";
import { ToggleGroup, ToggleGroupItem } from "./ui/toggle-group.tsx";
import { EmptyState } from "./composite/EmptyState.tsx";

const SOURCE_VARIANT: Record<LogEntry["source"], "default" | "secondary" | "warning" | "info"> = {
  slack: "info",
  web: "success" as const as "default",
  schedule: "warning",
};

export function LogsTab({ agentId }: { agentId: string }) {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "schedule">("all");
  const [refreshing, setRefreshing] = useState(false);

  const load = (quiet = false) => {
    if (!quiet) setLoading(true);
    else setRefreshing(true);
    api
      .logs(agentId, 200)
      .then((l) => {
        setLogs(l);
        setErr(null);
      })
      .catch((e) => setErr(String(e)))
      .finally(() => {
        setLoading(false);
        setRefreshing(false);
      });
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId]);

  useEffect(() => {
    const t = setInterval(() => load(true), 15_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId]);

  const shown = filter === "schedule" ? logs.filter((l) => l.source === "schedule") : logs;
  const scheduleCount = logs.filter((l) => l.source === "schedule").length;

  return (
    <div className="h-full flex flex-col">
      <div className="px-6 py-3 flex items-center gap-3 border-b border-border">
        <span className="text-xs text-muted-foreground">
          {shown.length} request{shown.length !== 1 ? "s" : ""}
        </span>
        <ToggleGroup
          type="single"
          value={filter}
          onValueChange={(v) => v && setFilter(v as "all" | "schedule")}
        >
          <ToggleGroupItem value="all" size="sm">All</ToggleGroupItem>
          <ToggleGroupItem value="schedule" size="sm">
            ⏱ Scheduled{scheduleCount ? ` (${scheduleCount})` : ""}
          </ToggleGroupItem>
        </ToggleGroup>
        <span className="text-[10px] text-muted-foreground/70">auto-refresh 15s</span>
        <Button variant="outline" size="sm" onClick={() => load()} className="ml-auto">
          <RefreshCw className={refreshing ? "h-3 w-3 animate-spin" : "h-3 w-3"} />
          Refresh
        </Button>
      </div>
      <div className="flex-1 overflow-y-auto">
        {err && <div className="p-6 text-destructive text-sm">{err}</div>}
        {loading && (
          <div className="p-3 space-y-1.5">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-14 w-full" />
            ))}
          </div>
        )}
        {!loading && shown.length === 0 && (
          <EmptyState
            icon={Inbox}
            title={filter === "schedule" ? "No scheduled runs yet" : "No logs yet"}
            body={
              filter === "schedule"
                ? "Logs appear here after a schedule fires."
                : "Requests are recorded from now on — mention the agent in Slack, chat here, or run a schedule."
            }
          />
        )}
        <div className="divide-y divide-border">
          {shown.map((l) => {
            const open = expanded === l._id;
            return (
              <div key={l._id} className="px-6 py-3 hover:bg-muted/30 transition-colors">
                <button
                  type="button"
                  className="w-full text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset rounded"
                  onClick={() => setExpanded(open ? null : l._id)}
                >
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Badge variant={SOURCE_VARIANT[l.source] ?? "secondary"} className="text-[10px]">
                      {l.source === "schedule" ? "⏱ schedule" : l.source}
                    </Badge>
                    {!l.ok && (
                      <Badge variant="destructive" className="text-[10px]">
                        error
                      </Badge>
                    )}
                    <span>{new Date(l.ts).toLocaleString()}</span>
                    <span className="text-muted-foreground/50">·</span>
                    <span>{l.requester}</span>
                  </div>
                  <div className="mt-1 text-sm truncate">{l.query || "—"}</div>
                  {!open && <div className="mt-0.5 text-xs text-muted-foreground truncate">{l.reply || "—"}</div>}
                </button>
                {open && (
                  <div className="mt-2 space-y-2">
                    <Field label="Query" value={l.query} />
                    <Field label="Reply" value={l.reply} />
                    {l.sessionId && (
                      <div className="text-[11px] text-muted-foreground font-mono">{l.sessionId}</div>
                    )}
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
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">{label}</div>
      <pre className="whitespace-pre-wrap break-words text-sm bg-card border border-border rounded-md p-3 max-h-72 overflow-y-auto">
        {value || "—"}
      </pre>
    </div>
  );
}
