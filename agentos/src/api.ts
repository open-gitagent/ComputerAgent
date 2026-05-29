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
  registeredBy?: string | null;
  lastSeen?: string | null;
}

export interface RegisterAgentInput {
  name: string;
  label?: string;
  harness?: string;
  source?: string;
  model?: string;
  registeredBy?: string;
}

/** Result of `displaySource(agent.source)`. Drives `<SourceBadge>` rendering. */
export interface SourceDisplay {
  kind: "git" | "local" | "inline" | "unknown";
  primary: string;
  secondary: string;
  href?: string;
}

/** Derive a render-ready breakdown of an agent's source. */
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
        (typeof source.manifest?.name === "string" && (source.manifest.name as string)) || "inline";
      return { kind: "inline", primary: name, secondary: "inline manifest" };
    }
    return parseGitUrl(source.url, source.ref);
  }
  return parseGitUrl(source);
}

function parseGitUrl(raw: string, ref?: string): SourceDisplay {
  const stripped = raw.replace(/^https?:\/\//, "").replace(/^git@/, "").replace(/\.git$/, "");
  const parts = stripped.split(/[:/]/).filter(Boolean);
  if (parts.length >= 3) {
    const [host, owner, repo] = parts;
    const href = `https://${host}/${owner}/${repo}${ref ? `/tree/${encodeURIComponent(ref)}` : ""}`;
    return { kind: "git", primary: `${owner}/${repo}`, secondary: host, href };
  }
  if (parts.length === 2) {
    const [owner, repo] = parts;
    return { kind: "git", primary: `${owner}/${repo}`, secondary: "github.com", href: `https://github.com/${owner}/${repo}` };
  }
  return { kind: "unknown", primary: raw, secondary: "" };
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

// Policies — SRS-managed. The browser only sees the bits that matter for
// the runtime (name, description, cedar/opa subsections). Everything else
// is forwarded by the server-side proxy; we don't reshape it.
export interface CedarPolicyEntry {
  id: string;
  name?: string;
  description?: string;
  policy_text: string;
  enabled?: boolean;
}
export interface CedarGuardrailConfig {
  enabled: boolean;
  policies: CedarPolicyEntry[];
  fail_open?: boolean;
}
export interface OPAManagedBinding {
  policy_id: string;
  hooks?: string[];
}
export interface OPAGuardrailConfig {
  enabled: boolean;
  source: "managed" | "external";
  managed_policies: OPAManagedBinding[];
  server_url?: string | null;
  policy_path?: string | null;
  mode?: "audit" | "enforce" | "fail_open" | "fail_closed";
  timeout_seconds?: number;
}
export interface PolicyDoc {
  _id: string;
  name: string;
  description: string;
  cedar_guardrail?: CedarGuardrailConfig | null;
  opa_guardrail?: OPAGuardrailConfig | null;
  created_at?: string;
  updated_at?: string;
  [k: string]: unknown;
}
export interface AgentPolicyBinding {
  _id: string;          // agent name
  policyId: string;
  updatedAt: string;
}

export interface OPAPolicyDoc {
  _id: string;
  name: string;
  description?: string;
  rego_content: string;
  created_at?: string;
  updated_at?: string;
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
  const r = await fetch(`/api${path}`, {
    headers: { accept: "application/json" },
    credentials: "include",
  });
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  return r.json() as Promise<T>;
}
async function postJSON<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`/api${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    credentials: "include",
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  return r.json() as Promise<T>;
}
async function reqJSON<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(`/api${path}`, {
    method,
    headers: { "content-type": "application/json", accept: "application/json" },
    credentials: "include",
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
  // Policies — SRS-proxied. Server injects x-api-key.
  policies: () => getJSON<{ policies: PolicyDoc[] }>("/policies").then((d) => d.policies),
  policy: (id: string) => getJSON<PolicyDoc>(`/policies/${encodeURIComponent(id)}`),
  createPolicy: (body: Partial<PolicyDoc>) => postJSON<PolicyDoc>("/policies", body),
  updatePolicy: (id: string, body: Partial<PolicyDoc>) =>
    reqJSON<{ success?: boolean } | PolicyDoc>("PUT", `/policies/${encodeURIComponent(id)}`, body),
  deletePolicy: (id: string) =>
    reqJSON<{ success?: boolean }>("DELETE", `/policies/${encodeURIComponent(id)}`),
  // Per-agent policy binding (Mongo, ours).
  getAgentPolicy: (agent: string) =>
    getJSON<{ binding: AgentPolicyBinding | null }>(`/agents/${encodeURIComponent(agent)}/policy`).then((d) => d.binding),
  setAgentPolicy: (agent: string, policyId: string | null) =>
    reqJSON<{ binding: AgentPolicyBinding | null }>("PUT", `/agents/${encodeURIComponent(agent)}/policy`, { policy_id: policyId }).then((d) => d.binding),
  // OPA rego policies (managed by SRS, referenced from RAI policies' opa_guardrail).
  opaPolicies: () => getJSON<{ policies: OPAPolicyDoc[] } | OPAPolicyDoc[]>("/opa-policies").then((d) => (Array.isArray(d) ? d : d.policies)),
  opaPolicy: (id: string) => getJSON<OPAPolicyDoc>(`/opa-policies/${encodeURIComponent(id)}`),
  createOpaPolicy: (body: { name: string; description?: string; rego_content: string }) =>
    postJSON<OPAPolicyDoc>("/opa-policies", body),
  updateOpaPolicy: (id: string, body: Partial<OPAPolicyDoc>) =>
    reqJSON<OPAPolicyDoc | { success?: boolean }>("PUT", `/opa-policies/${encodeURIComponent(id)}`, body),
  deleteOpaPolicy: (id: string) =>
    reqJSON<{ success?: boolean }>("DELETE", `/opa-policies/${encodeURIComponent(id)}`),
};
