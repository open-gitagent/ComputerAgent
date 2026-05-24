// Same-origin API client. In production Caddy proxies /api/* → Node /agentos/api/*
// and handles auth (the subdomain is gated by Caddy basic_auth). In dev, Vite
// proxies /api with an injected Basic Auth header. So the bundle never holds creds.

export interface Agent {
  name: string;
  label: string;
  harness: string;
  source: string;
  model: string | null;
  sandboxCapable: boolean;
  sessionCount: number;
  activeSandboxes: number;
  lastActivity: string | null;
  logCount: number;
}

export interface LogEntry {
  _id: string;
  ts: string;
  source: "slack" | "web" | "schedule";
  bot: string;
  requester: string;
  channel: string | null;
  threadTs: string | null;
  sessionId: string | null;
  query: string;
  reply: string;
  ok: boolean;
}

export interface SessionSummary {
  sessionId: string;
  bot: string;
  channel: string;
  threadTs: string;
  sandboxId: string | null;
  snapshotId: string | null;
  createdAt: string | null;
  lastMessageAt: string | null;
}

export interface TranscriptEntry { type: string; text: string; }
export interface SessionDetail {
  sessionId: string;
  thread: Record<string, unknown> | null;
  updatedAt: string | null;
  entries: TranscriptEntry[];
}

export interface Schedule {
  _id: string;
  agentName: string;
  prompt: string;
  kind: "interval" | "daily";
  intervalMinutes?: number;
  hourUtc?: number;
  minuteUtc?: number;
  enabled: boolean;
  description: string;
  nextRunAt: string;
  lastRunAt?: string | null;
  lastStatus?: "ok" | "error" | "running" | null;
  lastResult?: string | null;
}
export interface NewSchedule {
  agentName: string;
  prompt: string;
  kind: "interval" | "daily";
  intervalMinutes?: number;
  hourUtc?: number;
  minuteUtc?: number;
}

async function getJSON<T>(path: string): Promise<T> {
  const r = await fetch(`/api${path}`, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  return r.json() as Promise<T>;
}
async function postJSON<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`/api${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  return r.json() as Promise<T>;
}
async function reqJSON<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(`/api${path}`, {
    method,
    headers: { "content-type": "application/json", accept: "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  return r.json() as Promise<T>;
}

export const api = {
  agents: () => getJSON<{ agents: Agent[] }>("/agents").then((d) => d.agents),
  logs: (bot?: string, limit = 100) =>
    getJSON<{ logs: LogEntry[] }>(`/logs?limit=${limit}${bot ? `&bot=${encodeURIComponent(bot)}` : ""}`).then((d) => d.logs),
  sessions: (bot?: string, limit = 100) =>
    getJSON<{ sessions: SessionSummary[] }>(`/sessions?limit=${limit}${bot ? `&bot=${encodeURIComponent(bot)}` : ""}`).then((d) => d.sessions),
  session: (id: string) => getJSON<SessionDetail>(`/sessions/${encodeURIComponent(id)}`),
  chatSandbox: (agent: string, sessionId?: string) =>
    postJSON<{ sandboxId: string; sessionId: string; bot: string }>(
      `/agents/${encodeURIComponent(agent)}/chat-sandbox`,
      sessionId ? { sessionId } : {},
    ),
  logWebTurn: (entry: { bot: string; sessionId: string; query: string; reply: string; ok: boolean }) =>
    postJSON<{ ok: boolean }>("/logs", { ...entry, requester: "web" }),
  // SSE chat — caller reads the stream. Path goes through the same /api proxy.
  chatStreamUrl: (sandboxId: string) => `/api/sandboxes/${encodeURIComponent(sandboxId)}/chat`,
  // SSE one-shot run (deepagents). Server builds the /run body from {message}.
  runStreamUrl: (agent: string) => `/api/agents/${encodeURIComponent(agent)}/run`,
  // Schedules
  schedules: (agent?: string) =>
    getJSON<{ schedules: Schedule[] }>(`/schedules${agent ? `?agent=${encodeURIComponent(agent)}` : ""}`).then((d) => d.schedules),
  createSchedule: (s: NewSchedule) => postJSON<{ schedule: Schedule }>("/schedules", s).then((d) => d.schedule),
  updateSchedule: (id: string, fields: Partial<NewSchedule> & { enabled?: boolean }) =>
    reqJSON<{ schedule: Schedule }>("PATCH", `/schedules/${encodeURIComponent(id)}`, fields).then((d) => d.schedule),
  deleteSchedule: (id: string) => reqJSON<{ ok: boolean }>("DELETE", `/schedules/${encodeURIComponent(id)}`),
  runScheduleNow: (id: string) => postJSON<{ ok: boolean }>(`/schedules/${encodeURIComponent(id)}/run-now`, {}),
};
