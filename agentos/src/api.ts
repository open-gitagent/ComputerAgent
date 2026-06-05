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
  /** Registry surrogate key (Mongo ObjectId, stringified). The public/API
   *  identifier — routes are `/agents/:id` and all agent-scoped calls pass it.
   *  `name` is the human label/FK; never use it as the addressing key. */
  id: string;
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
  /** True when the agent can actually spin up a live chat sandbox.
   *  Equals `sandboxCapable && hasResolvableSource(source)`. Library-mode
   *  agents (Python harness, etc.) have `false` so the UI hides the
   *  "New chat" button instead of triggering a 400 on click. */
  liveChatCapable?: boolean;
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
  /** True when the agent is archived: kept (with all its history) but refused
   *  by every execution path. The UI lists archived agents in a separate,
   *  greyed section and disables chat/run for them. Unset/false ⇒ active. */
  archived?: boolean;
  archivedAt?: string | null;
  /** Owning group (visibility) + owning user id (mutate/delete). */
  ownerGroup?: string | null;
  ownerUser?: string | null;
}

export interface RegisterAgentInput {
  name: string;
  label?: string;
  harness?: string;
  source?: string;
  model?: string;
  registeredBy?: string;
  /** The group the new agent belongs to (one of the creator's groups). */
  ownerGroup?: string;
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
  // True when a live sandbox is currently serving this session — queried from
  // the harness registry at request time, not a stored flag.
  warm: boolean;
  createdAt: string | null;
  lastMessageAt: string | null;
}

// Cascade-delete response shared by agent + session delete. Counts are
// best-effort; `warnings` carries non-fatal harness/S3 cleanup failures.
export interface DeleteResult {
  ok: boolean;
  deleted: {
    sessions: number;
    snapshots: number;
    sandboxes: number;
    logs: number;
    messages: number;
  };
  warnings: string[];
}

export interface TranscriptEntry { type: string; text: string; }
export interface SessionDetail {
  sessionId: string;
  bot: string | null;
  warm: boolean;
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
  agentId: string;
  prompt: string;
  kind: "interval" | "daily";
  intervalMinutes?: number;
  hourUtc?: number;
  minuteUtc?: number;
}

// API keys — minted + stored (hashed) by the server; the plaintext is returned
// exactly once on create. List/responses are redacted (prefix + last4 only).
export interface ApiKey {
  _id: string;
  prefix: string;
  last4: string;
  label: string;
  /** Display label of the group/role the key acts as. */
  group?: string | null;
  /** Roles the key inherits → resolved to permissions via the role map. */
  roleIds?: string[];
  scopes?: string[]; // DEPRECATED
  createdBy: string;
  createdAt: string;
  expiresAt?: string | null;
  lastUsedAt?: string | null;
  revoked: boolean;
  revokedAt?: string | null;
}

// Current principal, from GET /me. Drives the SPA's permission gating.
export interface Me {
  id: string; // principal id (Keycloak sub) — compare to resource ownerUser
  user: string;
  displayName?: string | null;
  source: "oidc" | "api-key" | "cookie" | "dev";
  kind: "user" | "service";
  roles: string[];
  groups: string[];
  permissions: string[];
}

// Editable role → permission map (Settings → Roles).
export interface Role {
  _id: string;
  description: string;
  permissions: string[];
  builtin: boolean;
  updatedAt?: string;
}
export interface PermissionDef {
  key: string;
  description: string;
}

// Groups — read-only, sourced from Keycloak (Okta/Keycloak own groups + membership).
export interface Group {
  id: string;
  name: string;
  path: string;
}
export interface GroupMember {
  id: string;
  username: string | null;
  email: string | null;
  name: string | null;
  roles: string[];
}

// ── Auth: reactive token refresh ─────────────────────────────────────────────
// The BFF session cookie is short-lived (it tracks the Keycloak access-token
// expiry, ~5 min). When a dashboard request 401s we silently POST /auth/refresh
// (which rotates the server-held refresh token and re-signs the cookie) and
// replay the original request once. All concurrent 401s share ONE in-flight
// refresh — refresh tokens rotate and can be spent only once, so a stampede
// would invalidate itself. On a hard refresh failure the session is truly gone:
// we notify AuthContext (→ SSO sign-in screen).

let refreshInFlight: Promise<boolean> | null = null;
let onAuthLost: (() => void) | null = null;

/** AuthContext registers a callback here to flip to the anonymous/login state
 *  when the refresh token is dead (idle timeout / revocation / logout). */
export function setAuthLostHandler(fn: (() => void) | null): void {
  onAuthLost = fn;
}

function tryRefresh(): Promise<boolean> {
  if (!refreshInFlight) {
    refreshInFlight = fetch(`/api/v1/auth/refresh`, {
      method: "POST",
      headers: { accept: "application/json" },
      credentials: "include",
    })
      .then((r) => r.ok)
      .catch(() => false)
      .finally(() => {
        refreshInFlight = null;
      });
  }
  return refreshInFlight;
}

/** fetch against the dashboard API with credentials. On 401, refresh once and
 *  replay; if refresh fails, signal auth-lost and return the 401 response. */
async function authedFetch(path: string, init: RequestInit): Promise<Response> {
  const url = `/api/v1${path}`;
  const opts: RequestInit = { credentials: "include", ...init };
  let r = await fetch(url, opts);
  if (r.status === 401) {
    const ok = await tryRefresh();
    if (ok) {
      r = await fetch(url, opts);
    } else {
      onAuthLost?.();
    }
  }
  return r;
}

async function getJSON<T>(path: string): Promise<T> {
  const r = await authedFetch(path, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  return r.json() as Promise<T>;
}
async function postJSON<T>(path: string, body: unknown): Promise<T> {
  const r = await authedFetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  return r.json() as Promise<T>;
}
async function reqJSON<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await authedFetch(path, {
    method,
    headers: { "content-type": "application/json", accept: "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  return r.json() as Promise<T>;
}

// ── Evals ──────────────────────────────────────────────────────────────────
export interface GoldenExpectation {
  mode: "exact" | "contains" | "regex";
  value: string;
}
export interface EvalCase {
  id: string;
  prompt: string;
  criteria?: string;
  golden?: GoldenExpectation;
  expectedTools?: string[];
  forbiddenTools?: string[];
  maxCostUsd?: number;
  maxLatencyMs?: number;
}
export interface ScorerConfig {
  taskSuccess: boolean;
  toolCompliance: boolean;
  golden: boolean;
  nfr: boolean;
}
export interface EvalSuite {
  _id: string;
  name: string;
  description?: string;
  agentName: string;
  cases: EvalCase[];
  scorers: ScorerConfig;
  judges?: JudgeDef[];
  // legacy single-judge fields (read-only back-compat)
  judgeModel?: string;
  judgePrompt?: string;
  judgePassThreshold?: number;
  passThreshold?: number;
  createdAt?: string;
  updatedAt?: string;
}
export interface JudgeDef {
  id: string;
  name: string;
  rubric?: string;
  model?: string;
  passThreshold?: number;
}
export type EvalSuiteInput = Omit<EvalSuite, "_id" | "createdAt" | "updatedAt">;
export interface ScoreResult {
  scorer: "taskSuccess" | "toolCompliance" | "golden" | "nfr";
  label?: string;
  passed: boolean;
  score?: number;
  detail?: string;
}
export interface PolicyDenial {
  tool: string;
  reason: string;
}
export interface EvalTraceEntry {
  type: "thinking" | "text" | "tool_use" | "tool_result";
  text?: string;
  tool?: string;
  input?: unknown;
  isError?: boolean;
}
export interface CaseResult {
  caseId: string;
  prompt: string;
  output: string;
  toolCalls: string[];
  policyDenials: PolicyDenial[];
  transcript: EvalTraceEntry[];
  costUsd: number;
  latencyMs: number;
  scores: ScoreResult[];
  passed: boolean;
  error?: string;
}
export interface EvalRun {
  _id: string;
  suiteId: string;
  suiteName: string;
  agentName: string;
  status: "running" | "completed" | "failed";
  startedAt: string;
  completedAt?: string;
  results: CaseResult[];
  summary: { total: number; passed: number; passRate: number; gatePassed?: boolean };
  error?: string;
}

export const api = {
  agents: () => getJSON<{ agents: Agent[] }>("/agents").then((d) => d.agents),
  registerAgent: (input: RegisterAgentInput) =>
    postJSON<{ ok: boolean; id: string; name: string }>("/agents/register", input),
  unregisterAgent: (agentId: string) =>
    reqJSON<DeleteResult>("DELETE", `/agents/${encodeURIComponent(agentId)}`),
  patchAgent: (agentId: string, fields: Partial<Omit<RegisterAgentInput, "name">>) =>
    reqJSON<{ ok: boolean }>("PATCH", `/agents/${encodeURIComponent(agentId)}`, fields),
  archiveAgent: (agentId: string) =>
    reqJSON<{ ok: boolean; disposed: number; schedulesDisabled: number; warnings: string[] }>(
      "POST",
      `/agents/${encodeURIComponent(agentId)}/archive`,
    ),
  unarchiveAgent: (agentId: string) =>
    reqJSON<{ ok: boolean }>("POST", `/agents/${encodeURIComponent(agentId)}/unarchive`),
  logs: (agentId?: string, limit = 100) =>
    getJSON<{ logs: LogEntry[] }>(`/logs?limit=${limit}${agentId ? `&agentId=${encodeURIComponent(agentId)}` : ""}`).then((d) => d.logs),
  sessions: (agentId?: string, limit = 100) =>
    getJSON<{ sessions: SessionSummary[] }>(`/sessions?limit=${limit}${agentId ? `&agentId=${encodeURIComponent(agentId)}` : ""}`).then((d) => d.sessions),
  session: (id: string) => getJSON<SessionDetail>(`/sessions/${encodeURIComponent(id)}`),
  deleteSession: (id: string, agentId?: string) =>
    reqJSON<DeleteResult>(
      "DELETE",
      `/sessions/${encodeURIComponent(id)}${agentId ? `?agentId=${encodeURIComponent(agentId)}` : ""}`,
    ),
  chatSandbox: (agentId: string, opts?: { sessionId?: string; forceNew?: boolean }) =>
    postJSON<{ sandboxId: string; sessionId: string; bot: string }>(
      `/agents/${encodeURIComponent(agentId)}/chat-sandbox`,
      opts?.sessionId ? { sessionId: opts.sessionId } : opts?.forceNew ? { forceNew: true } : {},
    ),
  logWebTurn: (entry: { bot: string; sessionId: string; query: string; reply: string; ok: boolean }) =>
    postJSON<{ ok: boolean }>("/logs", { ...entry, requester: "web" }),
  // SSE chat — caller reads the stream. Path goes through the same /api proxy.
  chatStreamUrl: (sandboxId: string) => `/api/v1/sandboxes/${encodeURIComponent(sandboxId)}/chat`,
  // SSE one-shot run (deepagents). Server builds the /run body from {message}.
  runStreamUrl: (agentId: string) => `/api/v1/agents/${encodeURIComponent(agentId)}/run`,
  // Schedules
  schedules: (agentId?: string) =>
    getJSON<{ schedules: Schedule[] }>(`/schedules${agentId ? `?agentId=${encodeURIComponent(agentId)}` : ""}`).then((d) => d.schedules),
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
  getAgentPolicy: (agentId: string) =>
    getJSON<{ binding: AgentPolicyBinding | null }>(`/agents/${encodeURIComponent(agentId)}/policy`).then((d) => d.binding),
  setAgentPolicy: (agentId: string, policyId: string | null) =>
    reqJSON<{ binding: AgentPolicyBinding | null }>("PUT", `/agents/${encodeURIComponent(agentId)}/policy`, { policy_id: policyId }).then((d) => d.binding),
  // OPA rego policies (managed by SRS, referenced from RAI policies' opa_guardrail).
  opaPolicies: () => getJSON<{ policies: OPAPolicyDoc[] } | OPAPolicyDoc[]>("/opa-policies").then((d) => (Array.isArray(d) ? d : d.policies)),
  opaPolicy: (id: string) => getJSON<OPAPolicyDoc>(`/opa-policies/${encodeURIComponent(id)}`),
  createOpaPolicy: (body: { name: string; description?: string; rego_content: string }) =>
    postJSON<OPAPolicyDoc>("/opa-policies", body),
  updateOpaPolicy: (id: string, body: Partial<OPAPolicyDoc>) =>
    reqJSON<OPAPolicyDoc | { success?: boolean }>("PUT", `/opa-policies/${encodeURIComponent(id)}`, body),
  deleteOpaPolicy: (id: string) =>
    reqJSON<{ success?: boolean }>("DELETE", `/opa-policies/${encodeURIComponent(id)}`),

  // Current principal + session.
  auth: {
    me: () => getJSON<Me>("/me"),
    logout: () => postJSON<{ ok: boolean; logoutUrl?: string }>("/logout", {}),
    loginUrl: () => "/api/v1/auth/login",
  },

  // Roles — editable role→permission map + the permission catalog.
  roles: {
    list: () => getJSON<{ roles: Role[] }>("/roles").then((d) => d.roles),
    permissions: () => getJSON<{ permissions: PermissionDef[] }>("/permissions").then((d) => d.permissions),
    create: (body: { name: string; description?: string; permissions: string[] }) =>
      postJSON<{ role: Role }>("/roles", body).then((d) => d.role),
    update: (id: string, body: { description?: string; permissions?: string[] }) =>
      reqJSON<{ role: Role }>("PUT", `/roles/${encodeURIComponent(id)}`, body).then((d) => d.role),
    remove: (id: string) => reqJSON<{ ok: boolean }>("DELETE", `/roles/${encodeURIComponent(id)}`),
  },

  // Groups — read-only window into Keycloak (creation/membership live in Okta/KC).
  groups: {
    list: () => getJSON<{ groups: Group[] }>("/groups").then((d) => d.groups),
    members: (id: string) =>
      getJSON<{ members: GroupMember[]; truncated: boolean }>(`/groups/${encodeURIComponent(id)}/members`),
  },

  // API keys — mint (plaintext returned once), list (redacted), revoke. A key is
  // minted bound to a group/role and inherits its permissions.
  apiKeys: {
    list: () => getJSON<{ apiKeys: ApiKey[] }>("/api-keys").then((d) => d.apiKeys),
    create: (label: string, opts?: { expiresAt?: string | null; group?: string | null; roleIds?: string[] }) =>
      postJSON<{ key: string; apiKey: ApiKey }>("/api-keys", {
        label,
        ...(opts?.expiresAt ? { expiresAt: opts.expiresAt } : {}),
        ...(opts?.group ? { group: opts.group } : {}),
        ...(opts?.roleIds?.length ? { roleIds: opts.roleIds } : {}),
      }),
    revoke: (id: string) => reqJSON<{ ok: boolean }>("DELETE", `/api-keys/${encodeURIComponent(id)}`),
  },

  // Evals — suite CRUD + run trigger + run readback.
  evals: {
    listSuites: () => getJSON<{ suites: EvalSuite[] }>("/evals/suites").then((d) => d.suites),
    getSuite: (id: string) => getJSON<EvalSuite>(`/evals/suites/${encodeURIComponent(id)}`),
    createSuite: (body: EvalSuiteInput) => postJSON<EvalSuite>("/evals/suites", body),
    updateSuite: (id: string, body: EvalSuiteInput) =>
      reqJSON<EvalSuite>("PUT", `/evals/suites/${encodeURIComponent(id)}`, body),
    deleteSuite: (id: string) => reqJSON<{ ok: boolean }>("DELETE", `/evals/suites/${encodeURIComponent(id)}`),
    runSuite: (id: string) => postJSON<{ runId: string }>(`/evals/suites/${encodeURIComponent(id)}/run`, {}),
    generateCases: (agentName: string, count: number, focus?: string) =>
      postJSON<{ cases: EvalCase[] }>("/evals/generate", { agentName, count, focus }).then((d) => d.cases),
    listRuns: (suiteId?: string) =>
      getJSON<{ runs: EvalRun[] }>(`/evals/runs${suiteId ? `?suite=${encodeURIComponent(suiteId)}` : ""}`).then((d) => d.runs),
    getRun: (id: string) => getJSON<EvalRun>(`/evals/runs/${encodeURIComponent(id)}`),
  },
};
