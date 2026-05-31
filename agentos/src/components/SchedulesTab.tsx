import { useEffect, useState } from "react";
import { Calendar, Play, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api, type Schedule } from "../api.ts";
import { Card } from "./ui/card.tsx";
import { Button } from "./ui/button.tsx";
import { Textarea } from "./ui/textarea.tsx";
import { Input } from "./ui/input.tsx";
import { Label } from "./ui/label.tsx";
import { Badge } from "./ui/badge.tsx";
import { Switch } from "./ui/switch.tsx";
import { Skeleton } from "./ui/skeleton.tsx";
import { Separator } from "./ui/separator.tsx";
import { ToggleGroup, ToggleGroupItem } from "./ui/toggle-group.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select.tsx";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "./ui/alert-dialog.tsx";
import { EmptyState } from "./composite/EmptyState.tsx";

const INTERVAL_OPTIONS = [5, 10, 15, 30, 60, 180, 360, 720, 1440];
const fmtInterval = (m: number) => (m % 60 === 0 ? `${m / 60}h` : `${m}m`);

export function SchedulesTab({ agent, agentLabel }: { agent: string; agentLabel: string }) {
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

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
        agentName: agent,
        prompt: prompt.trim(),
        kind,
        ...(kind === "interval" ? { intervalMinutes } : { hourUtc, minuteUtc }),
      });
      setPrompt("");
      toast.success("Schedule created");
      load();
    } catch (e) {
      toast.error("Failed to create schedule", { description: String(e) });
    } finally {
      setCreating(false);
    }
  };

  const toggle = async (s: Schedule) => {
    await api.updateSchedule(s._id, { enabled: !s.enabled });
    load();
  };
  const remove = async (s: Schedule) => {
    await api.deleteSchedule(s._id);
    toast.success("Schedule deleted");
    load();
  };
  const runNow = async (s: Schedule) => {
    await api.runScheduleNow(s._id);
    toast.success("Running now…");
    setTimeout(load, 1500);
  };

  return (
    <div className="h-full overflow-y-auto px-6 py-5 max-w-3xl">
      {/* Create form */}
      <Card className="p-4">
        <div className="text-sm font-medium mb-3">
          Schedule a run · <span className="text-muted-foreground">{agentLabel}</span>
        </div>
        <Textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="What should the agent do on each run? e.g. 'Summarize new issues in the repo and post the highlights.'"
          rows={3}
        />
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <ToggleGroup type="single" value={kind} onValueChange={(v) => v && setKind(v as "interval" | "daily")}>
            <ToggleGroupItem value="interval" size="sm">Interval</ToggleGroupItem>
            <ToggleGroupItem value="daily" size="sm">Daily</ToggleGroupItem>
          </ToggleGroup>

          {kind === "interval" ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <span>every</span>
              <Select value={String(intervalMinutes)} onValueChange={(v) => setIntervalMinutes(Number(v))}>
                <SelectTrigger className="h-8 w-[80px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {INTERVAL_OPTIONS.map((m) => (
                    <SelectItem key={m} value={String(m)}>
                      {fmtInterval(m)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Label className="text-sm font-normal normal-case tracking-normal">daily at</Label>
              <Input
                type="number"
                min={0}
                max={23}
                value={hourUtc}
                onChange={(e) => setHourUtc(Number(e.target.value))}
                className="w-14 h-8 text-center tabular-nums"
              />
              <span>:</span>
              <Input
                type="number"
                min={0}
                max={59}
                value={minuteUtc}
                onChange={(e) => setMinuteUtc(Number(e.target.value))}
                className="w-14 h-8 text-center tabular-nums"
              />
              <span className="text-xs">UTC</span>
            </div>
          )}

          <Button onClick={create} disabled={!prompt.trim() || creating} className="ml-auto" size="sm">
            {creating ? "Creating…" : "Create schedule"}
          </Button>
        </div>
      </Card>

      {/* Schedules list */}
      <Separator className="my-6" />
      <Label className="block mb-3">Schedules</Label>
      {err && <div className="text-destructive text-sm mb-2">{err}</div>}
      {loading && (
        <div className="space-y-2">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      )}
      {!loading && schedules.length === 0 && (
        <EmptyState
          icon={Calendar}
          title="No schedules yet"
          body="Create a recurring run using the form above."
        />
      )}
      <div className="space-y-2">
        {schedules.map((s) => (
          <Card key={s._id} className="p-4 bg-card/60">
            <div className="flex items-start gap-3">
              <Switch
                checked={s.enabled}
                onCheckedChange={() => toggle(s)}
                aria-label={s.enabled ? "Disable" : "Enable"}
                className="mt-0.5 shrink-0"
              />
              <div className="min-w-0 flex-1">
                <div className="text-sm break-words">{s.prompt}</div>
                <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                  <Badge variant="secondary" className="text-[10px]">{s.description}</Badge>
                  <span>next: {new Date(s.nextRunAt).toLocaleString()}</span>
                  {s.lastRunAt && <span>last: {new Date(s.lastRunAt).toLocaleString()}</span>}
                  {s.lastStatus && (
                    <Badge
                      variant={
                        s.lastStatus === "ok"
                          ? "success"
                          : s.lastStatus === "error"
                          ? "destructive"
                          : "warning"
                      }
                      className="text-[10px]"
                    >
                      {s.lastStatus}
                    </Badge>
                  )}
                </div>
                {s.lastResult && (
                  <div className="mt-2 text-xs text-muted-foreground bg-muted rounded-md p-2 max-h-28 overflow-y-auto whitespace-pre-wrap border border-border">
                    {s.lastResult}
                  </div>
                )}
              </div>
              <div className="flex flex-col gap-1.5 shrink-0">
                <Button variant="ghost" size="sm" onClick={() => runNow(s)}>
                  <Play className="h-3 w-3" />
                  Run now
                </Button>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive hover:bg-destructive/10">
                      <Trash2 className="h-3 w-3" />
                      Delete
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Delete schedule?</AlertDialogTitle>
                      <AlertDialogDescription>
                        This will stop the recurring run. Existing logs from prior runs are preserved.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction onClick={() => remove(s)}>Delete</AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
