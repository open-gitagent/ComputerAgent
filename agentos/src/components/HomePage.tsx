/**
 * Home — a personalized SaaS workspace dashboard (no chat hero, no greeting).
 * A KPI stat row up top, then your agents + recent sessions + upcoming runs.
 * All widgets are read-scoped by the server (you only see what your
 * groups/ownership allow) and RBAC-gated in the UI.
 */
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Boxes,
  Activity,
  FlaskConical,
  ArrowRight,
  Clock,
  MessageSquare,
  Radio,
  CalendarClock,
} from "lucide-react";
import { api, type Schedule, type SessionSummary } from "../api.ts";
import { useAgents } from "../context/AgentsContext.tsx";
import { useAuth } from "../context/AuthContext.tsx";
import { RegisterAgentForm } from "./RegisterAgentForm.tsx";
import { Card } from "./ui/card.tsx";
import { Badge } from "./ui/badge.tsx";
import { Button } from "./ui/button.tsx";

function firstName(me: { displayName?: string | null; user?: string } | null): string {
  if (me?.displayName) return me.displayName.split(" ")[0]!;
  const local = me?.user?.split("@")[0] ?? "";
  const token = local.split(/[._-]/)[0] ?? "";
  return token ? token.charAt(0).toUpperCase() + token.slice(1) : "there";
}

function rel(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function until(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const s = Math.round((t - Date.now()) / 1000);
  if (s <= 0) return "due";
  if (s < 3600) return `in ${Math.floor(s / 60)}m`;
  if (s < 86400) return `in ${Math.floor(s / 3600)}h`;
  return `in ${Math.floor(s / 86400)}d`;
}

// ── KPI stat tile ──────────────────────────────────────────────────────
function Stat({
  icon: Icon,
  label,
  value,
  hint,
  accent = "text-muted-foreground",
  onClick,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: number | string;
  hint?: string;
  accent?: string;
  onClick?: () => void;
}) {
  return (
    <Card
      onClick={onClick}
      className={
        "p-4 transition-colors " +
        (onClick ? "cursor-pointer hover:border-primary/40 hover:bg-muted/30" : "")
      }
    >
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        <span className={"flex h-7 w-7 items-center justify-center rounded-md bg-muted " + accent}>
          <Icon className="h-4 w-4" />
        </span>
      </div>
      <div className="mt-3 text-2xl font-semibold tabular-nums tracking-tight">{value}</div>
      {hint && <div className="mt-0.5 text-[11px] text-muted-foreground">{hint}</div>}
    </Card>
  );
}

// ── List section card ──────────────────────────────────────────────────
function SectionCard({
  title,
  icon: Icon,
  action,
  children,
}: {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Card className="flex flex-col p-0 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <Icon className="h-4 w-4 text-muted-foreground" /> {title}
        </div>
        {action}
      </div>
      <div className="flex-1 p-1.5">{children}</div>
    </Card>
  );
}

const Empty = ({ text }: { text: string }) => (
  <div className="px-3 py-10 text-center text-xs text-muted-foreground">{text}</div>
);

export function HomePage() {
  const { agents, reload } = useAgents();
  const { me, can } = useAuth();
  const navigate = useNavigate();

  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [schedules, setSchedules] = useState<Schedule[]>([]);

  useEffect(() => {
    if (can("sessions:read")) api.sessions(undefined, 6).then(setSessions).catch(() => {});
    if (can("schedules:read")) api.schedules().then(setSchedules).catch(() => {});
  }, [can]);

  const liveAgents = useMemo(() => agents.filter((a) => !a.archived), [agents]);
  const topAgents = useMemo(
    () =>
      [...liveAgents]
        .sort((a, b) => new Date(b.lastActivity ?? 0).getTime() - new Date(a.lastActivity ?? 0).getTime())
        .slice(0, 6),
    [liveAgents],
  );
  const agentByName = useMemo(() => new Map(agents.map((a) => [a.name, a])), [agents]);
  const enabledSchedules = useMemo(() => schedules.filter((s) => s.enabled), [schedules]);
  const upcoming = useMemo(
    () =>
      [...enabledSchedules]
        .sort((a, b) => new Date(a.nextRunAt).getTime() - new Date(b.nextRunAt).getTime())
        .slice(0, 5),
    [enabledSchedules],
  );

  // ── KPI rollups from the data the user is already allowed to see ──
  const activeNow = useMemo(() => liveAgents.reduce((n, a) => n + (a.activeSandboxes || 0), 0), [liveAgents]);
  const totalSessions = useMemo(() => liveAgents.reduce((n, a) => n + (a.sessionCount || 0), 0), [liveAgents]);

  const isAdmin = !!me?.permissions.includes("*");
  const appRoles = (me?.roles ?? []).filter((r) => r.startsWith("agentos-")).map((r) => r.replace("agentos-", ""));
  const roleLabel = isAdmin ? "admin" : appRoles.length ? appRoles.join(", ") : "member";

  const openAgentByName = (name: string) => {
    const a = agentByName.get(name);
    if (a) navigate(`/agents/${encodeURIComponent(a.id)}`);
  };

  return (
    <div className="h-full overflow-y-auto bg-background text-foreground">
      <div className="mx-auto max-w-6xl px-6 py-8">
        {/* ── Header ── */}
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2.5">
              <h1 className="text-2xl font-semibold tracking-tight">Welcome back, {firstName(me)}</h1>
              <Badge variant="secondary" className="capitalize">{roleLabel}</Badge>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              Your agent operations at a glance
              {(me?.groups ?? []).length > 0 && (
                <span className="ml-1.5 inline-flex flex-wrap gap-1 align-middle">
                  {me!.groups.map((g) => (
                    <Badge key={g} variant="outline" className="text-[10px]">{g}</Badge>
                  ))}
                </span>
              )}
            </p>
          </div>

          {/* Quick actions */}
          <div className="flex items-center gap-2">
            {can("agents:read") && (
              <Button variant="outline" size="sm" className="gap-1.5" onClick={() => navigate("/registry")}>
                <Boxes className="h-4 w-4" /> Registry
              </Button>
            )}
            {can("obs:read") && (
              <Button variant="outline" size="sm" className="gap-1.5" onClick={() => navigate("/observability")}>
                <Activity className="h-4 w-4" /> Observability
              </Button>
            )}
            {can("agents:write") ? (
              <RegisterAgentForm onRegistered={() => reload()} />
            ) : null}
          </div>
        </div>

        {/* ── KPI row ── */}
        <div className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat
            icon={Boxes}
            label="Agents"
            value={liveAgents.length}
            hint={can("agents:write") ? "across your workspace" : "visible to you"}
            accent="text-foreground"
            onClick={can("agents:read") ? () => navigate("/registry") : undefined}
          />
          <Stat
            icon={Radio}
            label="Active now"
            value={activeNow}
            hint={activeNow === 1 ? "live sandbox" : "live sandboxes"}
            accent={activeNow > 0 ? "text-emerald-400" : "text-muted-foreground"}
          />
          <Stat
            icon={MessageSquare}
            label="Sessions"
            value={totalSessions}
            hint="total conversations"
            accent="text-sky-300"
          />
          <Stat
            icon={CalendarClock}
            label="Scheduled"
            value={enabledSchedules.length}
            hint={upcoming[0] ? `next ${until(upcoming[0].nextRunAt)}` : "no runs queued"}
            accent="text-foreground"
            onClick={can("schedules:read") ? () => navigate("/registry") : undefined}
          />
        </div>

        {/* ── Main grid ── */}
        <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
          {/* Your agents — wide */}
          <div className="lg:col-span-2">
            <SectionCard
              title="Your agents"
              icon={Boxes}
              action={
                <button
                  className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                  onClick={() => navigate("/registry")}
                >
                  View all <ArrowRight className="h-3 w-3" />
                </button>
              }
            >
              {topAgents.length === 0 ? (
                <Empty
                  text={can("agents:write") ? "No agents yet — register your first one." : "No agents in your groups yet."}
                />
              ) : (
                <div className="divide-y divide-border">
                  {topAgents.map((a) => (
                    <button
                      key={a.id}
                      onClick={() => navigate(`/agents/${encodeURIComponent(a.id)}`)}
                      className="flex w-full items-center gap-3 rounded-md px-2.5 py-2.5 text-left transition-colors hover:bg-muted/60"
                    >
                      <span
                        className={
                          "h-2 w-2 shrink-0 rounded-full " +
                          (a.activeSandboxes > 0 ? "bg-emerald-400 ring-2 ring-emerald-400/20" : "bg-muted-foreground/40")
                        }
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{a.label || a.name}</span>
                        <span className="block truncate text-[11px] text-muted-foreground">
                          {a.harness}
                          {a.ownerGroup ? ` · ${a.ownerGroup}` : ""}
                        </span>
                      </span>
                      <span className="hidden shrink-0 text-right sm:block">
                        <span className="block text-xs tabular-nums">{a.sessionCount}</span>
                        <span className="block text-[10px] text-muted-foreground">sessions</span>
                      </span>
                      <span className="w-16 shrink-0 text-right text-[11px] text-muted-foreground">
                        {rel(a.lastActivity)}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </SectionCard>
          </div>

          {/* Right column — sessions + runs stacked */}
          <div className="flex flex-col gap-4">
            {can("sessions:read") && (
              <SectionCard title="Recent sessions" icon={MessageSquare}>
                {sessions.length === 0 ? (
                  <Empty text="No sessions yet." />
                ) : (
                  <div className="divide-y divide-border">
                    {sessions.slice(0, 5).map((s) => (
                      <button
                        key={s.sessionId}
                        onClick={() => openAgentByName(s.bot)}
                        className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-muted/60"
                      >
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-1.5 truncate text-sm">
                            <span className="truncate">{s.bot}</span>
                            {s.warm && (
                              <Badge variant="success" className="px-1 text-[9px]">
                                live
                              </Badge>
                            )}
                          </span>
                          <span className="block truncate font-mono text-[10px] text-muted-foreground">
                            {s.sessionId}
                          </span>
                        </span>
                        <span className="shrink-0 text-[11px] text-muted-foreground">{rel(s.lastMessageAt)}</span>
                      </button>
                    ))}
                  </div>
                )}
              </SectionCard>
            )}

            {can("schedules:read") && (
              <SectionCard title="Upcoming runs" icon={Clock}>
                {upcoming.length === 0 ? (
                  <Empty text="No scheduled runs." />
                ) : (
                  <div className="divide-y divide-border">
                    {upcoming.map((s) => (
                      <button
                        key={s._id}
                        onClick={() => openAgentByName(s.agentName)}
                        className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-muted/60"
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm">{s.agentName}</span>
                          <span className="block truncate text-[11px] text-muted-foreground">{s.description}</span>
                        </span>
                        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                          {until(s.nextRunAt)}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </SectionCard>
            )}

            {/* Evals shortcut — fills the rail nicely + a real entry point */}
            {can("evals:read") && (
              <Card
                onClick={() => navigate("/evals")}
                className="flex cursor-pointer items-center gap-3 p-4 transition-colors hover:border-primary/40 hover:bg-muted/30"
              >
                <span className="flex h-9 w-9 items-center justify-center rounded-md bg-muted text-foreground">
                  <FlaskConical className="h-4 w-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">Agent Simulation Engine</span>
                  <span className="block text-[11px] text-muted-foreground">Run multi-judge evals</span>
                </span>
                <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" />
              </Card>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
