# ComputerAgent — services, credentials, and deploy history

> Handover doc for colleagues taking over the ComputerAgent stack. Covers what is deployed, where it lives, the credentials each service needs, and the chronological history of the changes that got us here.
>
> Excluded by request: `qa-worker-demo`, `computeragent-smoke`, IaC (k8s manifests, kustomize bases).

---

## 1. Code repositories

| Repo | Purpose | Default branch | Deploy branch |
|---|---|---|---|
| `open-gitagent/ComputerAgent` | TypeScript monorepo — harness server, engines, runtimes, AgentOS server + SPA, examples | `main` | `deploy` (long-lived release branch) |
| `NeuralgoLyzr/computer-agent-python-sdk` | Python SDK published as `computer-agent-py` on PyPI | `main` | tags `v*.*.*` trigger publish |

**Branch strategy for `ComputerAgent`:** `main` moves freely. Merge into `deploy` only when you want EKS images rebuilt. ECR repos are IMMUTABLE — every push gets a SHA tag. Roll forward by bumping the kustomize image tag, not by re-pushing.

---

## 2. Deployed services

### 2.1 PyPI — `computer-agent-py`

| Field | Value |
|---|---|
| Package | https://pypi.org/project/computer-agent-py/ |
| Current version | `0.2.0` (sdist + wheel published 2026-06-03) |
| Install | `pip install 'computer-agent-py[all]>=0.2.0'` |
| Source | [NeuralgoLyzr/computer-agent-python-sdk](https://github.com/NeuralgoLyzr/computer-agent-python-sdk) |
| Workflow | [`.github/workflows/publish.yml`](https://github.com/NeuralgoLyzr/computer-agent-python-sdk/blob/main/.github/workflows/publish.yml) |

**Publish flow:** tag a commit `v*.*.*` → GitHub Actions runs tests → builds with `uv build` → publishes via PyPI **Trusted Publishing (OIDC)**. No token in the workflow.

**Trusted Publisher config on PyPI:** the trust relationship was originally set up under the repo `open-gitagent/computer-agent-py`. After the move to `NeuralgoLyzr/computer-agent-python-sdk`, OIDC publishes need the PyPI project's "Publishing" settings re-pointed at the new repo. **Until that is re-pointed, fall back to manual `uv publish` with a token** (see emergency creds below).

**Emergency manual publish:**
```bash
cd computeragent-py
uv build
uv publish --username __token__ --password $PYPI_TOKEN
```

**Credentials required**
- For OIDC: nothing in the repo. PyPI's Trusted Publisher settings hold the trust.
- For manual fallback: `PYPI_TOKEN` — a PyPI API token scoped to `computer-agent-py`. **Rotate the one pasted into transcript history.**

---

### 2.2 AWS ECR — four Docker images

Workflow: [`.github/workflows/build-images.yml`](.github/workflows/build-images.yml)
Trigger: push to `deploy` (or tag `v*`).
Registry: `${AWS_ACCOUNT_ID}.dkr.ecr.us-east-1.amazonaws.com/agentos/<image>:<sha>`

| Image | Dockerfile | Entry / Purpose | Default port |
|---|---|---|---|
| `agentos/harness-server` | `examples/Dockerfile.harness` | `examples/harness-server.ts` — **bare** harness, just `/v1/sessions/*` | 7700 |
| `agentos/computeragent-server` | `examples/Dockerfile.harness` | `examples/computeragent-server.ts` — **full** harness, `/run + /sandboxes + /tasks + /snapshots` | 8787 |
| `agentos/agentos-server` | `packages/agentos-server/Dockerfile` | Dashboard / registry API (Express) | (see deploy manifests) |
| `agentos/agentos-spa` | `agentos/Dockerfile` | Vite SPA — UI for the registry / logs / chat | served by nginx in image |

Both harness variants share `examples/Dockerfile.harness`. Only the `ENTRY` build arg differs — same layers, different `CMD`.

**Tag policy.** ECR is **immutable**. The workflow only pushes SHA tags (`v*` tags also get a semver tag on tag pushes). If a SHA already exists in ECR, the workflow detects it and **skips silently** (no-op success — `aws ecr describe-images` short-circuits the build step).

**Bumping kustomize after a build:**
```bash
kustomize edit set image agentos/harness-server=$REGISTRY/agentos/harness-server:$SHA
```
The workflow Summary tab prints this exact command for the just-pushed SHA.

**Credentials required (GitHub repo secrets on `open-gitagent/ComputerAgent`)**

| Secret | Used for |
|---|---|
| `AWS_ACCOUNT_ID` | Composes registry URL `<id>.dkr.ecr.<region>.amazonaws.com` |
| `AWS_ACCESS_KEY_ID` | IAM principal with ECR push on `agentos/*` |
| `AWS_SECRET_ACCESS_KEY` | Paired secret |

Optional GitHub repo **variables** (build-time baked into the SPA bundle):
- `AWS_REGION` (default `us-east-1`)
- `VITE_AGENTOS_DEFAULT_HARNESS` (default `claude-agent-sdk`)
- `VITE_AGENTOS_DEFAULT_SOURCE` (default `github.com/shreyas-lyzr/general-agent`)
- `VITE_AGENTOS_DEFAULT_MODEL` (default `claude-sonnet-4-6`)

**IAM scope expected on the AWS creds:** push/pull on `agentos/*` ECR repos and `ecr:DescribeImages` (used by the skip-on-existing-SHA check).

---

### 2.3 MongoDB Atlas — AgentOS runtime backend

The Mongo cluster is the source of truth for AgentOS. **Only the `agentos-server` connects to Mongo.** As of the post-0.2.1 dev build, the Python SDK no longer writes Mongo directly — it POSTs telemetry to the server's ingest endpoint (`AgentOSHttpSink` → `POST /agentos/api/ingest/events`), and the server owns all writes. (The old `AgentRegistrySink` + `MongoMessageSink` and the `motor` dep were removed — see the Python SDK history below.)

**Collections (database = the server's `MONGO_DATABASE`):**
- `agent_registry` — one doc per registered agent (the server writes `source.type="library"` for harness-mode agents → AgentOS UI hides the chat-sandbox button for those, see commit `8d829b8`). Also carries **ownership** (`ownerGroup`/`ownerUser`, see §2.6b) and **GAP source sync** (`sourceSha`/`sourceSyncedAt` — the commit SHA the SDK last loaded; the `session_started` projection updates it and logs drift, see §2.6c).
- `agent_logs` — one doc per conversation (one `ComputerAgent` instance = one log row, multi-turn collapses correctly since the 0.2.0 session-id refactor)
- `sessions` — ordered chat transcript (one doc per session_id, entries appended in order; **`session_started` is the sole creator** of the doc, so a dropped/reordered start can't stub it)
- `chat_sessions` — the session-index row (`{_id, agent, createdAt, lastMessageAt}`) the dashboard's session list + per-agent `sessionCount`/`lastActivity` read. The server projection writes this so library-mode sessions show up (the old Python sink omitted it).
- `agent_messages` — per-event audit trail (every assistant_message / tool_use / tool_result lands here)
- `slack_threads` — Slack-bot chat-channel state only; **not** written by the ingest projection (it was dead/legacy for library agents).
- `roles` — the DB-backed RBAC map (`{_id: <Keycloak role name>, permissions[], builtin}`), editable in Settings→Roles; seeded with `agentos-admin`/`-editor`/`-viewer` (§2.6b).
- `api_keys` — AgentOS-issued service keys (`cak_…`), stored hashed; each carries `roleIds` (capability) + `group` (tenancy). Validated by the harness via introspection; permissions resolve from the same `roles` map (§2.6b).
- `git_credentials` — group-scoped git PATs (encrypted at rest), one per `(ownerGroup, host)`, used by the SDK to clone private GAP repos (§2.6c).

Resources stamped with `ownerGroup`/`ownerUser` are **hard-isolated**: a non-admin sees only their own or their group's; admins (`*`) see all (§2.6b).

**Credentials required:**
- On the **SDK** side: `AGENTOS_INGEST_URL` (e.g. `https://<host>/agentos/api/ingest/events`) + optional `AGENTOS_INGEST_TOKEN` (sent as `Authorization: Bearer …`). No Mongo creds.
- On the **server** side: `MONGO_URL` + `MONGO_DATABASE` (this is the DB the collections above live in).

**Behaviour:** when `AGENTOS_INGEST_URL` is set, the SDK's default telemetry pipeline auto-attaches `AgentOSHttpSink` (gated on the `[agentos]` extra, which is now `httpx`-based). Each event carries a stable `event_id` so the server's writes are idempotent on retry. ⚠️ When the server's `AGENTOS_INGEST_TOKEN` is unset the ingest route is **open** (anonymous writes) — set it on any network-exposed deployment.

---

### 2.6b AgentOS authentication + RBAC (Okta → Keycloak → BFF)

> The shared-password gate is gone. AgentOS now does real SSO + DB-backed RBAC + group ownership. Code lives under `packages/agentos-server/src/auth/`.

**Authentication — Okta federated by Keycloak, BFF session.** The app speaks only OIDC to Keycloak (which brokers Okta). `agentos-server` is the confidential `agent-os-server-client`: it runs Authorization Code + PKCE server-side (`auth/oidc.ts`, `routes/auth.ts`), verifies tokens via JWKS (`jose`), and sets an **httpOnly `agentos_session` cookie** carrying a signed principal snapshot — no token ever reaches the browser. The SPA is SSO-only (`LoginPage`).

**Token refresh (reactive).** The session cookie tracks the (short) access-token expiry; the server also holds a rotating refresh token in `agentos_refresh`. On a `401`, the SPA silently `POST /auth/refresh` (single-flight) and replays; a dead refresh token → SSO sign-in. So you stay logged in while active and only re-auth after Keycloak's SSO idle/max timeout.

**Authorization — DB-backed roles.** Keycloak emits role *names* (`realm_access.roles`) + `groups`; AgentOS owns what each role *can do* via the `roles` collection (editable in Settings→Roles). `authenticate → resolvePermissions → authorize(perm)` gates every dashboard route. Permission catalog is code-defined (`auth/permissions.ts`).

**Three guards / trust boundaries** (`app.ts`): SERVICE `/agentos/api/ingest/*` (`requireIngestAuth`, fails open) + `/agentos/api/keys/*` (`requireIntrospectionAuth`, fails closed); DASHBOARD `/agentos/api/v1/*` (`authenticate`); OBS `/v1/*`. `cak_` API keys authenticate at the dashboard boundary too (→ service principal with `groups=[key.group]`).

**Groups = read-only from Keycloak Admin API** (Settings→Groups). If a user's token lacks the `groups` claim, the server backfills groups from the Admin API at login/refresh (`auth/keycloak-admin.ts:listUserGroups`).

**Required env (server):**
- `KEYCLOAK_ISSUER_URL` = `https://<kc-host>/realms/<realm>` (e.g. realm `computer-agent`)
- `OIDC_CLIENT_ID` + `OIDC_CLIENT_SECRET` (confidential client); optional `OIDC_AUDIENCE`, `OIDC_REDIRECT_URI`, `OIDC_POST_LOGOUT_URI`, `OIDC_ROLES_CLAIM`/`OIDC_GROUPS_CLAIM`
- `AGENTOS_SESSION_SECRET` (HMAC for the signed cookies — **stable in prod**)
- `AGENTOS_DEFAULT_ROLE` (e.g. `agentos-viewer`) — fallback when the token has no AgentOS role
- `AGENTOS_BOOTSTRAP_ADMINS` (comma-sep emails granted `*` before role lookup — first-admin bring-up; remove after)
- `AGENTOS_DEV_AUTH=1` — **local only** dev bypass injecting an admin principal; never in deployed envs
- `KEYCLOAK_ADMIN_CLIENT_ID`/`SECRET` (defaults to the OIDC client) — service account needs `view-realm`/`view-users` for the Groups view + group backfill

> **Provisioning:** `pnpm --filter @computeragent/agentos-server provision:keycloak` (`scripts/provision-keycloak.mjs`) idempotently creates the realm, the three realm roles, the OIDC client (+ secret), the **Group Membership** mapper, and the service-account roles. Run with `DRY_RUN=1` first. Needs a Keycloak master-admin user/pass (used once, never stored).

### 2.6c Git credentials (private GAP repos) + SHA sync

> So the SDK can clone **private** GAP repos. Code: `auth/.../crypto/secret-box.ts`, `stores/git-credential-store.ts`, `routes/git-credentials.ts`; SDK side in `computeragent-py` (`harness/git_credential_client.py`, `substrates/local.py`).

- **Store.** A PAT is owned by a **group** and scoped to one **host** — one per `(ownerGroup, host)` in `git_credentials`, **AES-256-GCM encrypted at rest**. Managed in Settings→Git Credentials (perms `git-credentials:read`/`:manage`). The secret is write-only (never returned).
- **Resolve.** The SDK calls `POST /agentos/api/v1/git-credentials/resolve` with its `cak_` key; the server returns the decrypted PAT for the key's group + the repo host (strictly group-scoped, no admin bypass). The SDK injects it via `GIT_CONFIG_*`/`http.<host>.extraHeader` so the token never lands in `argv`/URL; SSH URLs pass through. Miss/401 → unauthenticated clone fallback (public repos unaffected).
- **SHA sync.** After cloning, the SDK runs `git rev-parse HEAD` and reports it as `agent_sha` on `session_started`; the projection writes `sourceSha`/`sourceSyncedAt` on the registry doc and logs any change. (Reactive — recorded on each run; the SDK already re-clones fresh, so the running agent is never stale.)

**Required env:**
- Server: `AGENTOS_CREDENTIALS_KEY` (base64 of 32 random bytes; **fail-closed** — credentials CRUD/resolve 503 without it). Optional `AGENTOS_CREDENTIALS_KEY_OLD` for rotation.
- SDK: `AGENTOS_API_URL` (e.g. `https://<host>/agentos/api/v1`) + the same `cak_` key it already uses (`COMPUTERAGENT_HARNESS_TOKEN` / `AGENTOS_INGEST_TOKEN`). The key's role must include `git-credentials:read`.

---

### 2.4 OpenTelemetry / New Relic

Every harness run emits GenAI-semconv spans + metrics through `OtelSink`. With env vars set, the sink ships out of process; without them it falls back to the console exporter.

**Credentials required (runtime env):**
- `OTEL_EXPORTER_OTLP_ENDPOINT` — e.g. `https://otlp.nr-data.net` for New Relic OTLP ingest
- `OTEL_EXPORTER_OTLP_HEADERS` — `api-key=<NR-license-key>` (comma-separated kv if multiple)
- `OTEL_SERVICE_NAME` — service identifier on spans (per environment)
- `COMPUTERAGENT_CAPTURE_CONTENT=1` — toggles capturing prompt/completion + tool args + tool results as span attributes/events
- `COMPUTERAGENT_CAPTURE_CONTENT_MODE=both` — `attribute`, `event`, or `both`

**Sink capabilities** — handles both `cumulative` and `delta` cost semantics (so the gitagent engine's delta usage rollups fold correctly, fix landed in 0.1.1).

---

### 2.5 Anthropic / Bedrock

The `claude-agent-sdk` engine spawns the Claude CLI subprocess, which authenticates one of two ways:

1. **Direct Anthropic** (default): `ANTHROPIC_API_KEY=sk-ant-...`
2. **AWS Bedrock**: AWS creds via `claude_env` dict passed through `envs=` on `ComputerAgent`. The CLI picks up `AWS_REGION`, `AWS_ACCESS_KEY_ID`/`SECRET`, plus Bedrock-style model ids like `us.anthropic.claude-sonnet-4-6`. NordAssist uses this path.

Optional: `ANTHROPIC_BASE_URL` if proxying through a gateway.

The Claude CLI itself is bundled — at install time `pip install claude-agent-sdk` pulls a 218 MB binary into `claude_agent_sdk/_bundled/claude`. **No separate CLI install needed**; the bundled binary is invoked by the SDK.

---

### 2.6 Gitagent engine — OpenAI-compatible endpoint

The `gitagent` engine (Python and TS) hits an OpenAI-compatible model endpoint. Same env contract on both sides so a single `.env` works for both languages.

**Credentials required:**
- `GITCLAW_MODEL_BASE_URL` — e.g. `https://api.lyzr.ai/v1`
- `OPENAI_API_KEY` — bearer for that endpoint

The model is taken from `RunTaskOptions.model` or the GAP repo's `agent.yaml` (`model: openai:gpt-4o-mini` / `anthropic:claude-...` — provider routed by prefix). If a GAP repo declares an Anthropic-shaped model, the engine routes to `ANTHROPIC_API_KEY` instead and these two stay unused.

---

## 3. `ComputerAgent` monorepo layout — what each package does

Top-level directories (`pnpm` workspace, `turbo` for the build graph):

| Path | Purpose |
|---|---|
| [`packages/`](packages/) | All publishable npm packages (24 of them, see table below). |
| [`agentos/`](agentos/) | **AgentOS SPA** — Vite + React + shadcn dashboard UI. Builds into a static bundle served by nginx in the `agentos/agentos-spa` image. Talks to `agentos-server` for the registry/logs/chat APIs. Build-time config via `VITE_AGENTOS_DEFAULT_*` env vars. |
| [`examples/`](examples/) | Standalone runnable entries: `harness-server.ts` (bare, port 7700), `computeragent-server.ts` (full, port 8787), plus quickstart scripts. Both server entries are baked into ECR images via `Dockerfile.harness`. |
| [`scripts/`](scripts/) | Repo automation (release prep, codemap generation, etc). |
| [`assets/`](assets/) | Diagrams + screenshots used in package READMEs. |

### Packages that matter most

**Core protocol + reference impl:**

| Package | What it does | Notes |
|---|---|---|
| `@computeragent/protocol` | The Harness Protocol — zod schemas, `EngineDriver` + `IdentityLoader` + `SessionStore` + `Substrate` contracts. | Every other package depends on this. Source of truth for the wire format. |
| `@computeragent/sdk` | Typed TypeScript client that consumes the SSE+POST harness API. | What Node/TS consumers import. |
| `computeragent` (umbrella) | Re-exports SDK + local substrate so `npm install computeragent` is the one-line install. | Convenience entry. |
| `@computeragent/harness-server` | Generic SSE+POST framework hosting pluggable engines + identity loaders. | This is what runs inside the `harness-server` and `computeragent-server` ECR images. |
| `@computeragent/cli` | `computeragent` CLI — run any GAP agent, anywhere, with any loop. | `pnpm install -g @computeragent/cli`. |
| `create-computeragent` | `npx create-computeragent my-agent` scaffolder. | New-project bootstrap. |

**AgentOS — the dashboard half of the stack:**

| Package | What it does | Notes |
|---|---|---|
| `@computeragent/agentos-server` | Express server — AgentOS dashboard API + observability read API. Talks to the harness over loopback HTTP and to MongoDB. Single container. | Shipped as the `agentos/agentos-server` ECR image. Extracted into its own service in commit `2756b9a`. |
| `agentos/` (SPA, no `packages/` entry) | The browser UI. | Builds into the `agentos/agentos-spa` ECR image. |
| `@computeragent/agent-registry-mongo` | MongoDB-backed agent registry + per-run audit log + `AgentTelemetry` impl. | This is what makes library-mode deployments (Python SDK, embedded harness) show up in the AgentOS dashboard with no extra orchestration. The `source.type="library"` field landed here. |
| `@computeragent/observability` | OpenTelemetry GenAI sink. Spec-compliant `gen_ai.*` spans, metrics, events. `AuditSink` interface. | The Python SDK's `OtelSink` is the Python equivalent. Drop-in for any OTLP collector / New Relic. |

**Engines — pluggable agent loops:**

| Package | What it does | Notes |
|---|---|---|
| `@computeragent/engine-claude-agent-sdk` | Wraps `@anthropic-ai/claude-agent-sdk`. Spawns the bundled Claude CLI subprocess. | Default engine. The Python SDK has the equivalent `ClaudeAgentEngine`. `IS_SANDBOX=1` fix landed in `af47a08`. |
| `@computeragent/engine-gitagent` | Wraps gitclaw (open-gitagent/gitagent) — OpenAI-compat backend. | Python equivalent is a re-implementation (`GitAgentEngine`), not a wrapper, since there's no Python gitclaw. |
| `@computeragent/engine-deepagents` | Wraps LangChain's deepagents (LangGraph) — planning + sub-agents + filesystem-backed loop. | Available only in TS for now. |

**Substrates — where the engine runs:**

| Package | What it does | Notes |
|---|---|---|
| `@computeragent/runtime-local` | Boots the harness server in a managed local Node subprocess. | Default. Docker IS the sandbox boundary inside ECR images. |
| `@computeragent/runtime-bwrap` | Bubblewrap sandbox — namespaces, FS jail, capability drop. | Linux-only. |
| `@computeragent/runtime-e2b` | E2B cloud sandbox. | Requires E2B API key. |
| `@computeragent/runtime-vzvm` | VZVirtualMachine via Tart. | Apple Silicon only. |

**Identity loaders — how an agent is sourced:**

| Package | What it does |
|---|---|
| `@computeragent/identity-gitagentprotocol` | GAP (GitAgentProtocol) — agent-as-git-repo. Reads `agent.yaml` + `SOUL.md` + `RULES.md`. Stitches them into the system prompt. |

**Stores — persistence:**

| Package | What it does |
|---|---|
| `@computeragent/session-store-mongo` | MongoDB-backed `SessionStore`. One doc per session, embedded `entries[]`, `_id = sessionId`, separate `projectKey` field. |
| `@computeragent/session-store-sqlite` | SQLite-backed `SessionStore`. WAL mode, prepared statements, `UNIQUE(session_id, uuid)` for idempotency. Used to stress-test the contract. |
| `@computeragent/task-store-mongo` | Persists the entire run lifecycle (status, every event, usage, artifacts). Fire-and-forget + poll by `taskId`. |
| `@computeragent/state-store-s3` | Workdir tarball + metadata per sandbox snapshot. Save/restore live sandbox state across the network. |

**Utilities:**

| Package | What it does |
|---|---|
| `@computeragent/llm-proxy-openai` | Translator: POST `/v1/messages` (Anthropic format) → `/v1/chat/completions` (OpenAI-compat). Lets Anthropic-shaped engines target any OpenAI backend (Lyzr Studio, vLLM, LiteLLM, Together). |
| `@computeragent/testing` | Mocks + helpers for testing harness servers, engines, identity loaders. |

### Mental model — how it all fits

```
┌─ Client (Python SDK / TS SDK / curl) ─┐
│                                       │
└────────────── SSE+POST ───────────────┘
                  │
                  ▼
┌─ harness-server (ECR image) ──────────┐
│  ┌─ EngineDriver ──┐  ┌─ Substrate ──┐│
│  │ claude-agent-sdk│  │ local        ││ ← swappable axes
│  │ gitagent        │  │ bwrap        ││
│  │ deepagents      │  │ e2b / vzvm   ││
│  └─────────────────┘  └──────────────┘│
│  ┌─ IdentityLoader ┐  ┌─ SessionStore┐│
│  │ gap             │  │ memory       ││
│  └─────────────────┘  │ mongo / sqlite│
│                       └──────────────┘│
└───────────────────────────────────────┘
         │                       │
         ▼                       ▼
   agent-registry-mongo    observability (OTel)
   task-store-mongo        ┌──────────────────┐
   state-store-s3          │ agentos-server   │ ← AgentOS dashboard API
                           │   (Express)      │
                           └──────────────────┘
                                    │
                                    ▼
                           ┌──────────────────┐
                           │ agentos-spa      │ ← Vite + React + shadcn UI
                           │   (nginx)        │
                           └──────────────────┘
```

The Python SDK (`computer-agent-py`) re-implements the harness layer in Python with the same four orthogonal axes. It POSTs telemetry to the AgentOS server (`AgentOSHttpSink` → `POST /agentos/api/ingest/events`), which projects it into the same MongoDB collections so library-mode Python agents show up in the AgentOS UI alongside TS harness-server-hosted ones. (Through 0.2.x the SDK wrote Mongo directly via `AgentRegistrySink` + `MongoMessageSink`; that was removed in favour of HTTP ingest so the SDK needs no Mongo creds and the schema lives server-side.)

---

## 4. Runtime environment — combined reference

Set everything that applies to the role. Harness server pods need (2.3) + (2.4) + (2.5) + (2.6). The SPA only needs the build-time `VITE_*` vars from §2.2.

```bash
# Anthropic (claude-agent-sdk engine, gitagent Anthropic backend)
ANTHROPIC_API_KEY=sk-ant-...
# Optional Bedrock / proxy
# ANTHROPIC_BASE_URL=https://api.anthropic.com

# OpenAI-compatible (gitagent OpenAI backend)
GITCLAW_MODEL_BASE_URL=https://api.lyzr.ai/v1
OPENAI_API_KEY=sk-...

# AgentOS persistence — SDK POSTs telemetry to the server; the server writes Mongo.
# On the SDK (library/worker) side:
AGENTOS_INGEST_URL=https://<agentos-host>/agentos/api/ingest/events
AGENTOS_INGEST_TOKEN=<shared-secret>          # optional; must match the server's
AGENTOS_API_URL=https://<agentos-host>/agentos/api/v1   # for private-GAP credential resolve (§2.6c)
COMPUTERAGENT_HARNESS_TOKEN=cak_...           # the AgentOS API key the SDK presents (role needs git-credentials:read)
# On the agentos-server side (NOT the SDK):
MONGO_URL=mongodb+srv://user:pass@cluster.mongodb.net
MONGO_DATABASE=computeragent
# AgentOS auth / RBAC (§2.6b) — SSO via Keycloak (Okta brokered), DB-backed roles:
KEYCLOAK_ISSUER_URL=https://<kc-host>/realms/computer-agent
OIDC_CLIENT_ID=agent-os-server-client
OIDC_CLIENT_SECRET=<confidential-client-secret>
AGENTOS_SESSION_SECRET=<stable-hmac-secret>
AGENTOS_DEFAULT_ROLE=agentos-viewer
# AGENTOS_BOOTSTRAP_ADMINS=you@org.com        # first-admin bring-up; remove after
# AGENTOS_DEV_AUTH=1                           # LOCAL ONLY — admin bypass, never deployed
# Git credentials at rest (§2.6c):
AGENTOS_CREDENTIALS_KEY=<base64 of 32 random bytes>

# OTel → New Relic
OTEL_EXPORTER_OTLP_ENDPOINT=https://otlp.nr-data.net
OTEL_EXPORTER_OTLP_HEADERS=api-key=<NR-license-key>
OTEL_SERVICE_NAME=computeragent-prod
COMPUTERAGENT_CAPTURE_CONTENT=1
COMPUTERAGENT_CAPTURE_CONTENT_MODE=both
```

---

## 5. Bringing up AgentOS — `agentos-server` + SPA

Three processes run together to give you a working AgentOS:

```
agentos-spa (nginx :80) ──/agentos/api/──▶  agentos-server (Express :8788) ──CA_BASE──▶  harness-server (:8787)
                                                    │
                                                    ├─▶  MongoDB (registry, logs, sessions)
                                                    └─▶  ClickHouse OR New Relic (traces)
```

Start order: **harness-server → agentos-server → agentos-spa**. The SPA proxies API calls through nginx to `agentos-server`, which in turn calls the harness via loopback HTTP (`CA_BASE`).

### 5.1 `harness-server` (port 8787)

Required for the AgentOS dashboard to actually run agents. If you only want the registry / logs / chat UI against historical data, you can start without it — anything that requires a fresh run will return 502.

```bash
# Docker (the ECR image used in prod)
docker run --rm -p 8787:8787 \
  -e ANTHROPIC_API_KEY \
  $REGISTRY/agentos/computeragent-server:$SHA

# Local dev
bun run examples/computeragent-server.ts
```

| Env | Required? | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | Yes (for `claude-agent-sdk` engine) | Or AWS creds if routing through Bedrock |
| `GITCLAW_MODEL_BASE_URL` + `OPENAI_API_KEY` | Yes (for `gitagent` engine only) | OpenAI-compat endpoint |
| `HOST` | Optional (default `0.0.0.0`) | |
| `PORT` | Optional (default `8787`) | |

### 5.2 `agentos-server` (port 8788)

```bash
# Docker (the ECR image used in prod)
docker run --rm -p 8788:8788 \
  -e MONGO_URL=mongodb+srv://... \
  -e MONGO_DATABASE=computeragent \
  -e CA_BASE=http://host.docker.internal:8787 \
  -e ANTHROPIC_API_KEY \
  $REGISTRY/agentos/agentos-server:$SHA

# Local dev
cd packages/agentos-server
pnpm dev                                  # tsx watch src/index.ts
# or
pnpm build && pnpm start                  # node dist/index.js
```

**Required env**

| Env | Notes |
|---|---|
| `MONGO_URL` | `mongodb+srv://user:pass@cluster/...` — required, server refuses to start without it |
| `MONGO_DATABASE` | Default `computeragent-test`. Set to `computeragent` / `computeragent-prod` per env |
| `CA_BASE` | URL of the harness-server. Default `http://127.0.0.1:8787`. In Docker, use `http://host.docker.internal:8787` (Mac/Win) or the harness container hostname (compose / k8s) |
| `ANTHROPIC_API_KEY` | Powers the `/completion` route (the "agent-less" chat from the SPA home page) |

**Optional env**

| Env | Default | Purpose |
|---|---|---|
| `AGENTOS_PORT` | `8788` | HTTP port |
| `CORS_ORIGIN` | empty | Comma-separated origins allowed to call the API (set to your SPA origin) |
| `NODE_ENV` | — | `production` enables secure cookies + tightens defaults |
| `COOKIE_SECURE` | derived from `NODE_ENV` | Force `true` / `false` explicitly |
| `AGENTOS_SESSION_SECRET` | random per boot | HMAC secret for the signed BFF cookies (`agentos_session`/`agentos_refresh`). **Set to a stable value in prod** or every session is invalidated on restart |
| `API_AUTH_USER` + `API_AUTH_PASS` | unset | **Legacy** — no longer gates the dashboard (SSO does, §2.6b). Now only used to build the Basic header for outbound loopback calls to the harness (`caAuthHeader`) |
| `AGENTOS_INGEST_TOKEN` | unset | Bearer token guarding `POST /agentos/api/ingest/events` (the Python SDK's telemetry ingest). When unset the route is **open** (anonymous writes to registry/logs/sessions) — set it on any network-exposed pod. The SDK must send the same value as `AGENTOS_INGEST_TOKEN`. |
| **Auth / RBAC** (§2.6b) | — | `KEYCLOAK_ISSUER_URL`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` (+ optional `OIDC_AUDIENCE`/`OIDC_REDIRECT_URI`/`OIDC_POST_LOGOUT_URI`/`OIDC_ROLES_CLAIM`/`OIDC_GROUPS_CLAIM`); `AGENTOS_DEFAULT_ROLE`, `AGENTOS_BOOTSTRAP_ADMINS`, `AGENTOS_DEV_AUTH=1` (local only); `KEYCLOAK_ADMIN_CLIENT_ID`/`SECRET` for the Groups view + group backfill. Provision with `pnpm provision:keycloak`. |
| **Git credentials** (§2.6c) | unset | `AGENTOS_CREDENTIALS_KEY` (base64 32B; **fail-closed** for credentials CRUD/resolve) + optional `AGENTOS_CREDENTIALS_KEY_OLD` for rotation. |
| `AGENTOS_API_KEY_PEPPER` / `AGENTOS_INTROSPECTION_SECRET` | unset | HMAC pepper for `api_keys` hashing; shared secret guarding `/agentos/api/keys/introspect` (harness↔server) |
| `AGENTOS_RUNTIME` | unset | Default substrate name used by the "Register agent" form (`local` / `bwrap` / `e2b` / `vzvm`) |
| `AGENTOS_SEED_DEFAULT` | unset | Set to `1` to auto-seed a default agent into the registry on first boot |
| `AGENTOS_DEFAULT_SOURCE` | `github.com/shreyas-lyzr/general-agent` | Used by the seed agent |
| `AGENTOS_DEFAULT_MODEL` | `claude-haiku-4-5` | Used by the seed agent and by `/completion` if `AGENTOS_COMPLETION_MODEL` unset |
| `AGENTOS_COMPLETION_MODEL` | falls back to `AGENTOS_DEFAULT_MODEL` | Model used by the SPA's home-page chat box |
| `AGENTOS_COMPLETION_MAX_TOKENS` | `4096` | |
| `ANTHROPIC_BASE_URL` | `https://api.anthropic.com` | Proxy / regional endpoint |

**Trace backend** — picks one of two backends for the observability read API:

| Env | Default | Purpose |
|---|---|---|
| `TRACE_BACKEND` | `clickhouse` | Set to `newrelic` to switch backends |

ClickHouse (when `TRACE_BACKEND=clickhouse`):

| Env | Default |
|---|---|
| `CLICKHOUSE_URL` | `http://localhost:8123` |
| `CLICKHOUSE_USER` | `default` |
| `CLICKHOUSE_PASSWORD` | empty |
| `CLICKHOUSE_DATABASE` | `otel` |

New Relic (when `TRACE_BACKEND=newrelic`):

| Env | Notes |
|---|---|
| `NEW_RELIC_USER_API_KEY` | Required. **User** API key (not license / ingest key) — needed for NerdGraph queries |
| `NEW_RELIC_ACCOUNT_ID` | Required. Numeric account id |
| `NEW_RELIC_REGION` | `US` (default) or `EU` |

### 5.3 `agentos-spa` (port 80 in container)

Pure static bundle served by nginx. **No runtime env** — everything is build-time `VITE_*`.

```bash
# Docker (the ECR image used in prod)
docker run --rm -p 8080:80 \
  $REGISTRY/agentos/agentos-spa:$SHA
# → open http://localhost:8080

# Local dev (with hot reload, talks to local agentos-server on :8788)
cd agentos
pnpm dev                                  # vite dev server
```

**Build-time args** (baked into the JS bundle — change → rebuild image):

| Build arg | Default | Purpose |
|---|---|---|
| `VITE_AGENTOS_DEFAULT_HARNESS` | `claude-agent-sdk` | Default engine pre-filled in the "Register agent" form |
| `VITE_AGENTOS_DEFAULT_SOURCE` | `github.com/shreyas-lyzr/general-agent` | Default source field |
| `VITE_AGENTOS_DEFAULT_MODEL` | `claude-sonnet-4-6` | Default model field |

**nginx upstream** — the SPA image's nginx config proxies `/agentos/api/` to `http://agentos:8788/agentos/api/`. The hostname `agentos` resolves via the docker-compose / k8s service name. If you run the containers standalone, add `--add-host agentos:host-gateway` (or just point the SPA dev server at the right URL via Vite proxy).

### 5.4 Minimal local quickstart — three terminals

```bash
# Terminal 1 — harness
export ANTHROPIC_API_KEY=sk-ant-...
bun run examples/computeragent-server.ts

# Terminal 2 — agentos-server
export MONGO_URL=mongodb+srv://...
export MONGO_DATABASE=computeragent-dev
export CA_BASE=http://127.0.0.1:8787
export ANTHROPIC_API_KEY=sk-ant-...
export TRACE_BACKEND=newrelic
export NEW_RELIC_USER_API_KEY=NRAK-...
export NEW_RELIC_ACCOUNT_ID=1234567
export AGENTOS_DEV_AUTH=1                  # local only — admin principal, no Keycloak needed (§2.6b)
# To exercise real SSO/RBAC locally instead, drop AGENTOS_DEV_AUTH and set the
# KEYCLOAK_ISSUER_URL / OIDC_* vars (run `pnpm provision:keycloak` first).
# For git-credentials locally: export AGENTOS_CREDENTIALS_KEY=$(openssl rand -base64 32)
cd packages/agentos-server && pnpm dev

# Terminal 3 — SPA
cd agentos && pnpm dev
# → http://localhost:5173 (Vite dev), proxies API → 8788
```

---

## 6. History of changes — what was done

Chronological from earliest to latest. Each entry has the commit ref where relevant.

### Python SDK (`computer-agent-py`)

| Commit | Change |
|---|---|
| `4395d64` | Initial commit at `0.1.3` — drop-in proxy: re-exports every `claude_agent_sdk` public symbol, wraps `query()` / `ClaudeSDKClient` through a telemetry pipeline (PII redaction, guardrails, OTel sink, AgentOS Mongo sink), adds OPA + Cedar policy engines via `PolicyToolAuthorizer`. |
| `b9d95e3` | **`0.2.0` — additive harness layer.** New top-level surface (`ComputerAgent`, `run_task`, `ChatHandle`, `ChatResult`). Four orthogonal Protocols (`EngineDriver`, `Substrate`, `SessionStore`, `IdentityLoader`). Two engines: `claude-agent-sdk` and `gitagent` (Python re-implementation of the gitclaw loop against OpenAI-compatible endpoints). `LocalSubstrate` with git-URL cloning. `InMemorySessionStore`. `PassthroughLoader` + `GapIdentityLoader` (reads `agent.yaml` + `SOUL.md` + `RULES.md` and stitches into system prompt). One stable `session_id` per `ComputerAgent` instance → multi-turn collapses correctly. Coordinator-side synthesis of `assistant_message`/`tool_use` events for both Anthropic and OpenAI payloads. `MongoMessageSink` now auto-attaches when `AGENTOS_MONGO_URL` is set (pre-fix only the registry sink auto-attached). **No breaking changes**; all 0.1.x callers unaffected. |

**Pending for `0.2.1`** (in-progress branch, not yet on PyPI): MongoDB SessionStore + SQLite SessionStore + conformance fixture + risk classification. See plan at `/Users/abhisheklyzr/.claude/plans/hey-i-need-the-idempotent-pretzel.md`. **Open decision before shipping:** align Python `SessionStore` Protocol exactly with TS / upstream `claude-agent-sdk.SessionStore` (batch `append`, `load → list | None`, drop `create`/`delete`, swap entry shape to `{type, uuid?, ...}`) — minor breaking change but unlocks drop-in compatibility with the upstream SDK's session-store plugin slot.

**Reference doc for NordAssist migration:** [`NORDASSIST_MIGRATION.md`](../NORDASSIST_MIGRATION.md) in the sibling `lyzr-experiments` folder — full diff for swapping `claude-agent-sdk` direct usage to `ComputerAgent + agent.chat()`, including the optional GAP-repo path.

### TypeScript monorepo (`ComputerAgent`)

| Commit | Change |
|---|---|
| `02dab13` | **CI: ECR build+push workflow gated on `deploy` branch.** Four images in parallel via matrix. |
| `c247b8a` | Harness-server built from `examples/Dockerfile.harness` via `ENTRY` build arg — same image as `computeragent-server`, only `CMD` differs. |
| `d50d2c3` | Dropped floating `deploy` / `main` ECR tags (ECR is IMMUTABLE so floating tags conflicted on every subsequent push). Added re-run idempotency — workflow skips if SHA already exists in ECR. |
| `f4d7c5a` | Surfaced install failures. Pre-fix the Dockerfile had `pnpm install && pnpm -r build || true` — sh `(A && B) || true` masked install failures from `pnpm install` itself. Split into separate `RUN` steps and replaced the wildcard build with `pnpm --filter @computeragent/harness-server... --filter @computeragent/examples... build` (the trailing `...` includes workspace deps but excludes the known-failing `@computeragent/cli` package). |
| `b0c5551` | Added `python3 make g++ pkgconfig` to the alpine builder so native-gyp deps (better-sqlite3, cpu-features, etc.) can compile. Without the toolchain `pnpm install --frozen-lockfile` exited non-zero on the first native postinstall. pnpm itself is installed via `bun install -g pnpm@9.4.0` since alpine-bun has no npm. |
| `1c5bceb` | Added support for New Relic OTLP ingest + DocumentDB connection strings. |
| `2756b9a` | `agentos-server`: dashboard API extracted into its own Express service; whole stack dockerized. |
| `af47a08` | `engine-claude-agent-sdk`: set `IS_SANDBOX=1` for the spawned Claude CLI (skips first-run telemetry prompts and treats the host as a sandbox). |
| `8d829b8` | `agentos`: introduced derived `liveChatCapable` field. SDK writes `source.type="library"` to `agent_registry` for harness-mode agents; UI checks `liveChatCapable` and hides the chat-sandbox button for those. Also strips model prefixes at every Mongo write site. |
| `feat/agentos-auth-rbac-refresh` (pushed) | **AgentOS auth + RBAC overhaul (§2.6b).** Replaced the shared password with Okta→Keycloak OIDC (BFF, httpOnly cookie, `jose` JWKS), DB-backed roles (`roles` collection, Settings→Roles), `ownerGroup`/`ownerUser` hard isolation, reactive token refresh (`/auth/refresh`, rotating refresh cookie), read-only Groups view + Admin-API group backfill, `buildApp()` route restructure into versioned `/agentos/api/v1/*` + trust-boundary groups. SPA: AuthContext + `can()`-gated controls, SSO LoginPage, personalized-workspace home, refined agent cards (3/row). Added `scripts/provision-keycloak.mjs` (`pnpm provision:keycloak`). |
| (same branch) | **Private-GAP git credentials + SHA sync (§2.6c).** `git_credentials` collection (AES-256-GCM at rest, one per `(ownerGroup,host)`), `POST /git-credentials/resolve` for the SDK's `cak_` key, `git-credentials:read`/`:manage` perms. SDK (`computeragent-py`): resolve client + `GIT_CONFIG_*` header injection (token never in argv) + `git rev-parse HEAD` capture → `agent_sha` → registry `sourceSha`/`sourceSyncedAt`. |

### Cross-cutting fixes worth knowing

- **Multi-chat lifecycle collapse.** Pre-0.2.0, every `agent.chat(...)` on the same `ComputerAgent` instance got its own `session_id`, so a five-turn conversation produced five orphan `sessions` docs and five `agent_logs` rows. Fixed by stamping one stable `session_id` per `ComputerAgent` lifetime — `session_started` / `session_ended` fire once per instance; per-chat events become ordered `user_message` entries inside the single session doc. Pipeline flushes at chat boundaries serialize the writes so order is preserved under concurrent chats.
- **Bundled Claude CLI is a transitive dep.** `pip install claude-agent-sdk` lands a 218 MB binary at `claude_agent_sdk/_bundled/claude`. Nothing extra to install. Confirmed by `pip show` + `find site-packages/claude_agent_sdk/_bundled`.
- **PyPI Trusted Publisher repo move.** Original trust was on `open-gitagent/computer-agent-py`. Source code moved to `NeuralgoLyzr/computer-agent-python-sdk`. OIDC publishes from the new repo will fail until the PyPI project's Publishing settings are re-pointed. Use the manual `uv publish` token fallback meanwhile.

---

## 7. Quick reference — commands

```bash
# ── Python SDK ────────────────────────────────────────────────────────
cd computer-agent-py
uv sync --all-extras --dev
uv run pytest -q -m "not integration"
uv build                                    # creates dist/*.whl + dist/*.tar.gz
uv publish --username __token__ --password $PYPI_TOKEN

# ── ComputerAgent monorepo (TS) ───────────────────────────────────────
pnpm install --frozen-lockfile
pnpm --filter @computeragent/harness-server... \
     --filter @computeragent/examples... build
docker build -f examples/Dockerfile.harness \
  --build-arg ENTRY=examples/harness-server.ts \
  -t harness-server .

# ── Trigger ECR build ─────────────────────────────────────────────────
git push origin deploy                      # builds all 4 images at HEAD sha

# ── Roll forward on EKS after a successful build ──────────────────────
kustomize edit set image \
  agentos/harness-server=$REGISTRY/agentos/harness-server:$SHA
```

---

## 8. Where to look for X

| Question | File / location |
|---|---|
| What does the harness API look like in Python? | `computeragent-py/src/computeragent/harness/coordinator.py` |
| Where are engines registered? | `computeragent-py/src/computeragent/engines/__init__.py` |
| What does the TS harness server route? | `packages/harness-server/src/` |
| ECR build pipeline | [`.github/workflows/build-images.yml`](.github/workflows/build-images.yml) |
| PyPI publish pipeline | `computer-agent-python-sdk/.github/workflows/publish.yml` |
| SPA build args | `agentos/Dockerfile` + workflow `VITE_*` vars |
| Mongo collections written by SDK | `computeragent-py/src/computeragent/telemetry/sinks/agentos.py` |
| AgentOS auth / OIDC / BFF + refresh | `packages/agentos-server/src/auth/{oidc,authenticate,authorize,ownership,keycloak-admin}.ts`, `routes/auth.ts` |
| Permission catalog + role seeds | `packages/agentos-server/src/auth/permissions.ts`, `stores/role-store.ts` |
| Route composition / trust boundaries | `packages/agentos-server/src/app.ts`, `routes/dashboard.ts` |
| Git-credential store + resolve endpoint | `packages/agentos-server/src/crypto/secret-box.ts`, `stores/git-credential-store.ts`, `routes/git-credentials.ts` |
| SDK private-repo clone (PAT + SHA) | `computeragent-py/src/computeragent/harness/git_credential_client.py`, `substrates/local.py` |
| Keycloak provisioning script | `packages/agentos-server/scripts/provision-keycloak.mjs` (`pnpm provision:keycloak`) |
| Migration recipe (NordAssist QA) | `lyzr-experiments/NORDASSIST_MIGRATION.md` |
| In-progress 0.2.1 plan | `~/.claude/plans/hey-i-need-the-idempotent-pretzel.md` |
| GAP-auth + SHA-sync plan | `~/.claude/plans/reflective-mapping-lovelace.md` |

