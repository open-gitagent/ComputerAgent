// Same-origin API client. In production Caddy proxies /api/* → Node /agentos/api/*
// and handles auth (the subdomain is gated by Caddy basic_auth). In dev, Vite
// proxies /api with an injected Basic Auth header. So the bundle never holds creds.

/** Mirrors the protocol's IdentitySource zod schema. The server narrows on
 *  read; the dashboard renders the structured form when present. */
export type IdentitySource =
  | { type: "git"; url: string; ref?: string; subdir?: string }
  | { type: "local"; path: string }
  | { type: "inline"; manifest: Record<string, unknown>; files?: Record<string, string> };

export interface Agent {
  name: string;
  label: string;
  harness: string;
  /** Structured IdentitySource for registry agents (preferred); legacy string
   *  for in-memory agents from the hardcoded config. Use `sourceUrl` for the
   *  canonical identity / display URL. */
  source: IdentitySource | string;
  /** Canonical URL/path for this agent. Git: the repo URL. Local: the path.
   *  Inline: the literal string "inline". The dashboard treats this as the
   *  de-duplication key alongside `name`. */
  sourceUrl: string | null;
  model: string | null;
  sandboxCapable: boolean;
  sessionCount: number;
  activeSandboxes: number;
  lastActivity: string | null;
  logCount: number;
  /** "in-memory" = configured at server startup (Slack bots, built-ins).
   *  "registry"  = registered dynamically via the SDK's MongoTelemetry
   *                hook or via POST /agents/register. */
  origin?: "in-memory" | "registry";
  /** Free-form attribution (hostname / pod / "seed-script") for registry agents. */
  registeredBy?: string | null;
  /** Most recent ComputerAgent construct seen by the SDK telemetry hook. */
  lastSeen?: string | null;
}

/** Result of `displaySource(agent.source)`. Drives `<SourceBadge>` rendering. */
export interface SourceDisplay {
  kind: "git" | "local" | "inline" | "unknown";
  /** Headline (e.g. "open-gitagent/ComputerAgent" for git). */
  primary: string;
  /** Subtitle (e.g. "github.com" host or full path). */
  secondary: string;
  /** `https://` URL to open when clicked (git only). */
  href?: string;
}

/**
 * Derive a render-ready breakdown of an agent's source. Recognizes common
 * git hosts (github.com / gitlab.com / bitbucket.org / open-gitagent.dev,
 * with or without a leading scheme) and splits owner/repo. Falls back
 * gracefully for unrecognized forms.
 */
export function displaySource(source: IdentitySource | string | null | undefined): SourceDisplay {
  if (!source) return { kind: "unknown", primary: "(no source)", secondary: "" };

  if (typeof source === "object") {
    if (source.type === "local") {
      const path = source.path;
      const tail = path.split("/").filter(Boolean).slice(-2).join("/");
      return { kind: "local", primary: tail || path, secondary: path };
    }
    if (source.type === "inline") {
      const name =
        (typeof source.manifest?.name === "string" && (source.manifest.name as string)) ||
        "inline";
      return { kind: "inline", primary: name, secondary: "inline manifest" };
    }
    // git
    return parseGitUrl(source.url, source.ref);
  }
  // Legacy: bare string. Treat as a git-style "host/owner/repo".
  return parseGitUrl(source);
}

function parseGitUrl(raw: string, ref?: string): SourceDisplay {
  // Strip protocol + trailing .git
  const stripped = raw.replace(/^https?:\/\//, "").replace(/^git@/, "").replace(/\.git$/, "");
  const parts = stripped.split(/[:/]/).filter(Boolean);
  // host/owner/repo
  if (parts.length >= 3) {
    const [host, owner, repo] = parts;
    const href = `https://${host}/${owner}/${repo}${ref ? `/tree/${encodeURIComponent(ref)}` : ""}`;
    return { kind: "git", primary: `${owner}/${repo}`, secondary: host, href };
  }
  // Just "owner/repo" — assume github.
  if (parts.length === 2) {
    const [owner, repo] = parts;
    return { kind: "git", primary: `${owner}/${repo}`, secondary: "github.com", href: `https://github.com/${owner}/${repo}` };
  }
  return { kind: "unknown", primary: raw, secondary: "" };
}

export interface RegisterAgentInput {
  name: string;
  label?: string;
  harness?: string;
  source?: string;
  model?: string;
  registeredBy?: string;
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
  registerAgent: (input: RegisterAgentInput) =>
    postJSON<{ ok: boolean; name: string }>("/agents/register", input),
  unregisterAgent: (name: string) =>
    reqJSON<{ ok: boolean }>("DELETE", `/agents/${encodeURIComponent(name)}`),
  patchAgent: (name: string, fields: Partial<Omit<RegisterAgentInput, "name">>) =>
    reqJSON<{ ok: boolean }>("PATCH", `/agents/${encodeURIComponent(name)}`, fields),
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
