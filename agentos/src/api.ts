// Same-origin API client. In production Caddy proxies /api/* → Node /agentos/api/*
// and handles auth (the subdomain is gated by Caddy basic_auth). In dev, Vite
// proxies /api with an injected Basic Auth header. So the bundle never holds creds.

export interface Agent {
  name: string;
  harness: string;
  source: string;
  model: string | null;
  sessionCount: number;
  activeSandboxes: number;
  lastActivity: string | null;
  logCount: number;
}

export interface LogEntry {
  _id: string;
  ts: string;
  source: "slack" | "web";
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
};
