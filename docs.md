# ComputerAgent — Reference Documentation

The complete API and protocol reference for [`computeragent`](https://www.npmjs.com/package/computeragent) and the `@open-gitagent/*` / `@computeragent/*` workspace packages.

Companion reads:
- [`README.md`](README.md) — install + quickstart + the "why"
- [`packages/computeragent/info.md`](packages/computeragent/info.md) — architecture deep-dive + diagrams
- [`CHANGELOG.md`](CHANGELOG.md) — release notes

---

## Table of contents

- [Install](#install)
- [Quickstart](#quickstart)
- [Core API](#core-api)
  - [`ComputerAgent`](#computeragent)
  - [`agent.chat()` and `ChatHandle`](#agentchat-and-chathandle)
  - [`runTask()` (one-shot)](#runtask-one-shot)
- [`IdentitySource` — where the agent comes from](#identitysource--where-the-agent-comes-from)
- [Substrates — where the agent runs](#substrates--where-the-agent-runs)
- [Engines (harnesses) — the agent loop](#engines-harnesses--the-agent-loop)
- [Session stores — conversation memory](#session-stores--conversation-memory)
- [Telemetry — `AgentTelemetry` + `AuditSink`](#telemetry--agenttelemetry--auditsink)
- [Permissions / Human-in-the-loop](#permissions--human-in-the-loop)
- [Policy — `Cedar` + `OPA` guardrails](#policy--cedar--opa-guardrails)
- [Configuration reference](#configuration-reference)
- [HTTP wire protocol](#http-wire-protocol)
- [CLI](#cli)
- [Errors](#errors)
- [Companion packages](#companion-packages)
- [Versioning](#versioning)

---

## Install

The umbrella package gives you `ComputerAgent`, `runTask`, `LocalSubstrate`, and all SDK types — enough for a complete agent in one import.

```bash
npm install computeragent
```

For other substrates, session stores, or telemetry backends, install the scoped packages alongside:

```bash
# Substrates
npm install @computeragent/runtime-bwrap      # Linux user-namespace sandbox
npm install @computeragent/runtime-e2b        # E2B Firecracker microVM
npm install @computeragent/runtime-vzvm       # Apple VZ.framework via Tart

# Session stores (conversation memory)
npm install @open-gitagent/session-store-mongo
npm install @computeragent/session-store-sqlite

# Telemetry
npm install @open-gitagent/agent-registry-mongo   # MongoTelemetry + AuditSink
```

Requirements: **Node 22+** or **Bun 1.1+** (the SDK targets modern async iterators + `using` semantics).

---

## Quickstart

```ts
import { ComputerAgent, LocalSubstrate } from "computeragent";

const agent = new ComputerAgent({
  source:  { type: "git", url: "github.com/open-gitagent/general-agent" },
  harness: "claude-agent-sdk",
  runtime: new LocalSubstrate(),
  envs:    { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY! },
});

const result = await agent.chat("Summarize this repo in two sentences.");
console.log(result.messages.at(-1));
console.log(`Cost: $${result.usage.costUsd}`);
```

That's it. Same shape works against any substrate (`E2BSubstrate`, `BwrapSubstrate`, …), any engine (`"gitagent"`, `"deepagents"`), and any session store (Mongo, SQLite, file).

---

## Core API

### `ComputerAgent`

```ts
import { ComputerAgent } from "computeragent";

const agent = new ComputerAgent(options: ComputerAgentOptions);
```

#### `ComputerAgentOptions`

| Field | Type | Required | What it does |
|---|---|:-:|---|
| `source` | `IdentitySource \| string` | ✓ | Where to load the agent from — see [IdentitySource](#identitysource--where-the-agent-comes-from). String form is shorthand for `{ type: "git", url: <string> }`. |
| `harness` | `"claude-agent-sdk" \| "gitagent" \| "deepagents" \| string` | ✓ | Engine to drive the loop. Custom engines registered on the harness server are accepted too. |
| `runtime` | `"local" \| Substrate \| string` | | Where the harness runs. Omit / `"local"` for the default `harnessUrl`. Pass a `Substrate` object to have the SDK call `bootHarness()` on first chat. |
| `harnessUrl` | `string` | | Override the harness URL. Defaults to `http://127.0.0.1:7700`. |
| `envs` | `Record<string, string>` | | Env vars forwarded to the engine subprocess (`ANTHROPIC_API_KEY`, `GITHUB_TOKEN`, etc.). |
| `model` | `string` | | Override the agent's `model.preferred`. Engine-specific value (e.g. `"claude-haiku-4-5-20251001"`). |
| `temperature` | `number` | | Override `model.constraints.temperature`. Honored by engines that expose it (gitagent yes; claude-agent-sdk v0.2.x no — warns once and ignores). |
| `baseUrl` | `string` | | Custom Anthropic-compatible endpoint. Injected as `ANTHROPIC_BASE_URL` if not already in `envs`. Useful for Helicone, OpenRouter, LiteLLM, self-hosted gateways. |
| `sessionId` | `string` | | Resume a specific session. With a `sessionStore`, replays prior entries. Without, server auto-mints a fresh id. |
| `sessionStore` | `SessionStoreConfig` | | Conversation memory — see [Session stores](#session-stores--conversation-memory). |
| `attachments` | `Attachment[]` | | Files materialized into the agent's workdir before the engine starts. Path-jailed. |
| `options` | `Record<string, unknown>` | | Engine-specific options forwarded as `body.options` (e.g. `permissionMode`, `maxTurns`, `settingSources`). |
| `onToolCall` | `(call: ToolCallContext) => Promise<PermissionDecision> \| PermissionDecision` | | HITL callback for tool gating — see [Permissions](#permissions--human-in-the-loop). Auto-allows if omitted. |
| `policy` | `{ kind: "srs"; endpoint; apiKey; policyId; principalId }` | | Per-session policy decider config — see [Policy](#policy--cedar--opa-guardrails). |
| `telemetry` | `AgentTelemetry` | | Telemetry hook — see [Telemetry](#telemetry--agenttelemetry--auditsink). |
| `identityLoader` | `string` | | Identity loader. Default: `"gitagentprotocol"`. |
| `fetch` | `typeof fetch` | | Custom fetch impl (tests, proxies). |
| `debug` | `boolean` | | Forces `COMPUTERAGENT_LOG=debug` in the harness + emits one client log per consumed event. |

#### Methods

| Method | Returns | Notes |
|---|---|---|
| `agent.chat(input)` | `ChatHandle` | The main turn. Dual interface — see below. |
| `agent.dispose()` | `Promise<void>` | Tear down the substrate, delete the server session. Implicit when used with `await using`. |
| `agent.harnessUrl()` | `Promise<string>` | The resolved harness URL (async because substrates may boot lazily). |
| `agent.fetchArtifact(path)` | `Promise<Uint8Array \| null>` | Pull a file the agent wrote out of its workdir. |
| `agent.listWorkdir(opts?)` | `Promise<FsTreeEntry[]>` | List the agent's workdir contents. |

#### Disposal

```ts
// Explicit:
const agent = new ComputerAgent({...});
try { /* … */ } finally { await agent.dispose(); }

// Modern (auto-dispose at scope exit):
await using agent = new ComputerAgent({...});
// no try/finally needed
```

---

### `agent.chat()` and `ChatHandle`

```ts
const handle: ChatHandle = agent.chat(input);
```

`ChatHandle` has a **dual interface**, inspired by `client.messages.stream(...)` in the Anthropic SDK:

| Use | What you get |
|---|---|
| `for await (const ev of handle) { … }` | Raw `HarnessEvent`s as they arrive |
| `await handle` (or `await handle.result()`) | `ChatResult` — drained to completion |
| `handle.getUsage()` | Snapshot of running `UsageRollup` at any time (works mid-stream and post-drain) |
| `handle.sessionId()` | Resolves to the real session id once `POST /v1/sessions` returns |
| `handle.cancel()` | POST `/v1/sessions/:id/cancel` to abort the in-flight turn |
| `handle.respondToPermission(callId, decision)` | Manually answer a permission request when iterating events directly |

#### `ChatResult`

```ts
interface ChatResult {
  readonly sessionId: string;
  readonly messages: ReadonlyArray<unknown>;      // engine-native payloads
  readonly ended: { kind: "ca_session_ended"; reason: string; errorMessage?: string };
  readonly usage: UsageRollup;
}

interface UsageRollup {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly costUsd: number | undefined;
}
```

> **Cost semantics:** tokens always SUM across `ca_usage_snapshot` events. Cost depends on the engine's `costSemantic`: `"cumulative"` (claude-agent-sdk) takes the MAX; `"delta"` (gitclaw) SUMs. Pinned by 7 dedicated tests in `packages/sdk/src/chat-handle.test.ts`.

#### `ChatInput`

```ts
type ChatInput =
  | string                              // user text
  | UserMessage                         // {role:"user", content:[...]}
  | UserMessage[]                       // multi-message turn
  | AsyncIterable<UserMessage>;         // streaming input
```

---

### `runTask()` (one-shot)

```ts
import { runTask, LocalSubstrate } from "computeragent";

const result = await runTask({
  source:  { type: "git", url: "github.com/<org>/<repo>" },
  harness: "claude-agent-sdk",
  runtime: new LocalSubstrate(),
  envs:    { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY! },
  message: "Summarize the code in 3 bullets.",
});
```

Equivalent to:

```ts
const agent = new ComputerAgent(opts);
try { return await agent.chat(message); }
finally { await agent.dispose(); }
```

Use this when you don't need to inspect mid-flight events or push follow-ups — i.e. most automation scripts and CLI tools.

---

## `IdentitySource` — where the agent comes from

Three shapes, all valid for the `source` field:

### `{ type: "git" }` — clone from a remote repo

```ts
source: {
  type:   "git",
  url:    "github.com/<org>/<repo>",
  ref:    "v1.2.3",            // optional — branch/tag/SHA
  subdir: "agents/triage",     // optional — sub-path inside the repo
}
```

The git URL **is** the canonical agent identity. With `MongoTelemetry`, the same URL across machines deduplicates to the same `agent_registry` row.

> Authentication: set `GITHUB_TOKEN` in `envs` (or in the harness env). The harness bakes it into the clone URL — your token never reaches the engine subprocess.

### `{ type: "local" }` — use a directory already on disk

```ts
source: {
  type: "local",
  path: "/Users/me/my-agent",
}
```

The path must contain an `agent.yaml` per [GitAgent Protocol](https://github.com/open-gitagent/gitagent-protocol). No clone, no fetch — fastest for iteration.

### `{ type: "inline" }` — pass the manifest in-memory

```ts
source: {
  type: "inline",
  manifest: { name: "hello", version: "0.1.0" },
  files: {
    "agent.yaml": [
      'spec_version: "0.1.0"',
      "name: hello",
      "version: 0.1.0",
      "model:",
      "  preferred: claude-haiku-4-5-20251001",
    ].join("\n"),
    "SOUL.md": "Respond in one short sentence.",
  },
}
```

No I/O needed. Useful for tests, dynamic agents, and "throwaway" prompts.

### String shorthand

```ts
source: "github.com/<org>/<repo>"   // → { type: "git", url: "github.com/<org>/<repo>" }
```

---

## Substrates — where the agent runs

A `Substrate` is the thing that hosts the harness server. The SDK calls `substrate.bootHarness()` on first `chat()`, gets back a URL, and proxies everything else through that URL.

| Substrate | Package | Use when | Startup |
|---|---|---|---|
| `LocalSubstrate` | `@open-gitagent/runtime-local` (bundled in `computeragent`) | dev, library-mode in your existing worker | <100ms (subprocess) |
| `BwrapSubstrate` | `@computeragent/runtime-bwrap` | "isolation without containers" on Linux | ~50ms (user-namespaces) |
| `E2BSubstrate` | `@computeragent/runtime-e2b` | strong isolation, untrusted code | ~2s (Firecracker microVM) |
| `VZSubstrate` | `@computeragent/runtime-vzvm` | macOS-native VM, full OS, persistent disk | ~3s (Tart-managed VZ) |

```ts
// Subprocess on the host
import { LocalSubstrate } from "computeragent";
runtime: new LocalSubstrate({
  workdir:           "/tmp/agent-work",          // optional, defaults to a temp dir
  inheritEnv:        true,                        // forward host env to harness
  harnessBinaryPath: "/custom/path/to/harness",   // optional override
}),

// Linux bubblewrap
import { BwrapSubstrate } from "@computeragent/runtime-bwrap";
runtime: new BwrapSubstrate({
  bind: ["/etc/ssl/certs:/etc/ssl/certs:ro"],
}),

// E2B cloud microVM
import { E2BSubstrate } from "@computeragent/runtime-e2b";
runtime: new E2BSubstrate({
  apiKey:     process.env.E2B_API_KEY!,
  templateId: "computeragent-base",  // E2B template with bun + git pre-installed
}),

// VZ on macOS
import { VZSubstrate } from "@computeragent/runtime-vzvm";
runtime: new VZSubstrate({
  vmName: "agent-host-ubuntu",
}),
```

Same `ComputerAgent` constructor in every case — agent code is fully substrate-agnostic. There's a [substrate × source × engine matrix test](packages/sdk/src/substrate-matrix.test.ts) that fires every cell of the grid.

---

## Engines (harnesses) — the agent loop

Set with `harness:` in `ComputerAgentOptions`.

| Name | Package | What it wraps | Use when |
|---|---|---|---|
| `"claude-agent-sdk"` | `@computeragent/engine-claude-agent-sdk` | `@anthropic-ai/claude-agent-sdk` v0.2.x | Default. Streaming + tool use + permission callback + sessions + budget. |
| `"gitagent"` | `@computeragent/engine-gitagent` | `gitclaw` CLI | Any OpenAI-compatible model (`openai:<model>@<baseUrl>`); GAP-native agents. |
| `"deepagents"` | `@computeragent/engine-deepagents` | LangChain `deepagents` | LangGraph-style agents needing tool integrations from the LangChain ecosystem. |

Custom engines: implement `EngineDriver` (`packages/protocol/src/contracts.ts`) and register via `createHarnessServer({ engines })` on a self-hosted harness.

> **`harness` is a string — open to extension.** TypeScript narrows the built-ins for autocomplete; any string the running harness server has registered is accepted at runtime.

---

## Session stores — conversation memory

Conversation persistence is one constructor arg. The harness resolves the `kind` via its registry.

| Kind | Package | Backend |
|---|---|---|
| `"memory"` | built-in | In-process map (default — non-persistent) |
| `"file"` | built-in | JSONL on local disk |
| `"mongo"` | `@open-gitagent/session-store-mongo` | MongoDB collection |
| `"sqlite"` | `@computeragent/session-store-sqlite` | Local SQLite DB |

```ts
// In-memory (default — drops on dispose)
sessionStore: undefined,

// JSONL files
sessionStore: { kind: "file", options: { root: "./sessions" } },

// MongoDB — shared across pods, resume from any worker
sessionStore: {
  kind: "mongo",
  options: { url: process.env.MONGO_URL!, database: "agentos" },
},

// SQLite — fast, embedded, queryable
sessionStore: {
  kind: "sqlite",
  options: { path: "./sessions.sqlite" },
},
```

### Resuming a session

```ts
const agent = new ComputerAgent({
  ...opts,
  sessionId:    "sess_abc123",                                   // ← prior session id
  sessionStore: { kind: "mongo", options: { url, database } },
});
await agent.chat("Continue where we left off.");
```

If the store has prior entries for that `sessionId`, the engine replays them and continues. If not, a fresh session is minted at that id.

---

## Telemetry — `AgentTelemetry` + `AuditSink`

Two parallel hooks:

### `AgentTelemetry` (SDK-side, library-mode)

The hook that fires from the SDK when running in library-mode (e.g. inside a Temporal worker). Designed for the case where there's no central harness server collecting traces — the SDK itself emits.

```ts
import { ComputerAgent } from "computeragent";
import { MongoTelemetry } from "@open-gitagent/agent-registry-mongo";

const agent = new ComputerAgent({
  ...opts,
  telemetry: new MongoTelemetry({
    url:      process.env.MONGO_URL!,
    database: "agentos",
    agent:    { name: "triage", source: opts.source, harness: opts.harness },
  }),
});
```

Hooks fired (all optional, all fire-and-forget — exceptions never propagate):

```ts
interface AgentTelemetry {
  onAgentConstructed?(info: AgentConstructedInfo): void | Promise<void>;
  onChatStart?(info: ChatStartInfo): void | Promise<unknown>;     // optional context for onChatEnd
  onChatEnd?(info: ChatEndInfo, context?: unknown): void | Promise<void>;
  onClose?(): void | Promise<void>;
}
```

### `AuditSink` (harness-side, server-mode)

The hook the harness server fires for each engine event, used when the harness is its own service. Plug in `OtelAuditSink` to emit `gen_ai.*` OpenTelemetry spans:

```ts
import { configureOtel, OtelAuditSink } from "@computeragent/observability";

configureOtel({
  serviceName: "computeragent",
  exporter:    "otlp-http",
  endpoint:    process.env.OTEL_EXPORTER_OTLP_ENDPOINT!,
});

const auditSink = new OtelAuditSink();

const server = new ComputerAgentServer({ /* ..., */ auditSink });
```

Spans use the **OpenTelemetry `gen_ai.*` semantic conventions** — `gen_ai.system`, `gen_ai.request.model`, `gen_ai.usage.input_tokens`, `gen_ai.response.cost_usd`. Any OTel-compatible APM (Honeycomb, Datadog, Grafana, ClickHouse) renders the spans natively.

---

## Permissions / Human-in-the-loop

Every tool call the engine wants to make can be gated. Two ways:

### `onToolCall` callback (per-agent)

```ts
const agent = new ComputerAgent({
  ...opts,
  onToolCall: async ({ callId, toolName, input, risk }) => {
    if (toolName === "Bash" && (input as { command?: string }).command?.startsWith("rm")) {
      return { decision: "deny", reason: "rm denied by policy" };
    }
    return { decision: "allow" };
  },
});
```

`PermissionDecision` shapes:

```ts
type PermissionDecision =
  | { decision: "allow" }
  | { decision: "deny";   reason?: string }
  | { decision: "modify"; input: Record<string, unknown> };
```

### TTY approval (CLI scripts)

```ts
import { ttyApproval } from "computeragent";

const agent = new ComputerAgent({
  ...opts,
  onToolCall: ttyApproval(),   // prompts at the terminal for each tool call
});
```

### Manual iteration

If you iterate events yourself, respond explicitly:

```ts
const handle = agent.chat("...");
for await (const ev of handle) {
  if (ev.kind === "ca_permission_request") {
    await handle.respondToPermission(ev.callId, { decision: "allow" });
  }
}
```

Default behavior (no callback, no manual response): the handle auto-replies `allow` to every request.

---

## Policy — `Cedar` + `OPA` guardrails

Pluggable policy backend that gates tool calls without round-tripping to a client.

```ts
const agent = new ComputerAgent({
  ...opts,
  policy: {
    kind:        "srs",
    endpoint:    "https://your-policy-service.example.com",
    apiKey:      process.env.SRS_API_KEY!,
    policyId:    "policy_abc123",
    principalId: "user:alice",
  },
});
```

The harness fetches the policy once (cached) and evaluates every tool call against the cedar_guardrail + opa_guardrail subsections. Decision (`allow`/`deny` + reason) is emitted as a `ca_permission_decision` event for audit.

Fail-closed: if the policy service returns 5xx or times out, the harness defaults to **deny**. A guardrail outage should not silently disable enforcement.

---

## Configuration reference

### Environment variables (read by the engine subprocess)

| Var | What |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic direct path |
| `ANTHROPIC_BASE_URL` | Override Anthropic endpoint (Helicone, OpenRouter, proxies) |
| `CLAUDE_CODE_USE_BEDROCK` | Route through AWS Bedrock instead of Anthropic direct |
| `AWS_REGION`, `AWS_DEFAULT_REGION` | Bedrock region |
| `AWS_BEDROCK_MODEL_ID` | E.g. `us.anthropic.claude-haiku-4-5-20251001-v1:0` |
| `AWS_ROLE_ARN`, `AWS_WEB_IDENTITY_TOKEN_FILE` | IRSA-injected on EKS (no static keys needed) |
| `AWS_PROFILE`, `AWS_SHARED_CREDENTIALS_FILE`, `AWS_CONFIG_FILE` | Alternative AWS auth paths |
| `GITHUB_TOKEN` | For cloning private agent source repos |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP collector URL (turns on `OtelAuditSink`) |
| `OTEL_SERVICE_NAME` | Service name on emitted spans (default: `computeragent`) |
| `COMPUTERAGENT_LOG` | `debug` / `info` / `warn` / `error` / `silent` (engine + framework log level) |

Allow-list of host env vars the engine inherits is in [`packages/engine-claude-agent-sdk/src/engine.ts`](packages/engine-claude-agent-sdk/src/engine.ts) → `inheritEssentialHostEnv()`.

### Model overrides

Resolution order (highest wins):

1. `options.model` constructor arg (engine-specific path through `body.options`)
2. `model:` constructor arg (high-level shortcut — sets both `model` and `body.options.model`)
3. `agent.yaml`'s `model.preferred`
4. Engine default (claude-agent-sdk → `claude-haiku-4-5-20251001`)

---

## HTTP wire protocol

The harness server exposes a small REST + SSE surface — `curl` can drive every endpoint. Schemas live in [`packages/protocol/src/`](packages/protocol/) and are Zod-validated.

### REST

| Method | Path | What |
|---|---|---|
| `GET` | `/health` | Liveness |
| `POST` | `/v1/sessions` | Start a session — body: `{source, harness, runtime, envs, sessionId?, …}` |
| `GET` | `/v1/sessions/:id` | Session status |
| `POST` | `/v1/sessions/:id/messages` | Push a user turn (multi-turn flow) |
| `POST` | `/v1/sessions/:id/permission/:callId` | Respond to a permission request — body: `{decision, reason?, input?}` |
| `POST` | `/v1/sessions/:id/cancel` | Abort the in-flight turn |
| `DELETE` | `/v1/sessions/:id` | Tear down + free workdir |
| `GET` | `/v1/sessions/:id/fs/tree?depth=N` | List the agent's workdir |
| `GET` | `/v1/sessions/:id/fs/file?path=...` | Fetch a file the agent wrote |

### SSE event stream

`POST /v1/sessions` returns `text/event-stream`. Events:

```ts
type HarnessEvent =
  | { kind: "ca_session_started";    sessionId; engine; identity; capabilities }
  | { kind: "sdk_message";           sessionId; payload }            // engine-native
  | { kind: "ca_permission_request"; sessionId; callId; toolName; input; risk? }
  | { kind: "ca_permission_decision";sessionId; callId; decision; reason? }
  | { kind: "ca_turn_started";       sessionId; userTextLen? }
  | { kind: "ca_usage_snapshot";     sessionId;
                                     inputTokens?; outputTokens?;
                                     cacheCreationInputTokens?; cacheReadInputTokens?;
                                     costUsd?; costSemantic?: "cumulative" | "delta" }
  | { kind: "ca_session_ended";      sessionId; reason; errorMessage? };
```

Every event has a monotonic `id`. Reconnect with `Last-Event-ID: <last-id>` and the harness replays from the per-session ring buffer (default: last 1,000 events / 5 minutes).

### One-line curl

```bash
curl -N -X POST http://127.0.0.1:7700/v1/sessions \
  -H 'content-type: application/json' \
  -d '{
    "source": "github.com/open-gitagent/general-agent",
    "harness": "claude-agent-sdk",
    "envs": { "ANTHROPIC_API_KEY": "sk-ant-…" },
    "message": "Reply: PING"
  }'
```

---

## CLI

A thin wrapper that exposes the same options as a CLI. Useful for shell scripts and CI.

```bash
npx computeragent run \
  --source github.com/open-gitagent/general-agent \
  --harness claude-agent-sdk \
  --message "Summarize the README in 3 bullets"
```

Common flags:

| Flag | Maps to |
|---|---|
| `--source` | `source` (git URL or local path) |
| `--harness` | `harness` |
| `--model` | `model` |
| `--temperature` | `temperature` |
| `--runtime` | `runtime` (`local` / `e2b` / `bwrap` / `vz`) |
| `--session-id` | `sessionId` |
| `--session-store` | `sessionStore.kind` (`memory` / `file` / `mongo` / `sqlite`) |
| `--debug` | `debug: true` |
| `--message` | one-shot `agent.chat(input)` and exit |

See [`packages/cli/`](packages/cli/) for the full reference.

---

## Errors

The SDK throws typed errors from [`packages/sdk/src/errors.ts`](packages/sdk/src/errors.ts):

| Class | When |
|---|---|
| `HarnessProtocolError` | Server returned a non-2xx, malformed SSE, or unexpected message order |
| `UnknownEngineError` | `harness:` value isn't registered on the running server |
| `UnknownLoaderError` | `identityLoader:` value isn't registered |
| `UnknownStoreError` | `sessionStore.kind` isn't registered |

All extend `Error` and carry `.cause` when there's an underlying network/parse error. Catch them surgically:

```ts
import { HarnessProtocolError, UnknownEngineError } from "computeragent";

try {
  await agent.chat("…");
} catch (e) {
  if (e instanceof HarnessProtocolError) { /* retry, swap harness url, … */ }
  if (e instanceof UnknownEngineError)   { /* "did you mean…" */ }
  throw e;
}
```

> `AuditSink` / `AgentTelemetry` errors **never** propagate. They're caught, logged at debug level, and swallowed. Telemetry must never break an agent run.

---

## Companion packages

| Package | Role |
|---|---|
| [`@open-gitagent/protocol`](packages/protocol/) | Wire-protocol schemas (Zod) — `HarnessEvent`, `IdentitySource`, REST request/response shapes |
| [`@open-gitagent/sdk`](packages/sdk/) | The user-facing SDK (`ComputerAgent`, `ChatHandle`, `runTask`) |
| [`@open-gitagent/runtime-local`](packages/runtime-local/) | Default `LocalSubstrate` |
| [`@computeragent/runtime-bwrap`](packages/runtime-bwrap/) | Linux user-namespace sandbox |
| [`@computeragent/runtime-e2b`](packages/runtime-e2b/) | E2B microVM substrate |
| [`@computeragent/runtime-vzvm`](packages/runtime-vzvm/) | Apple VZ.framework substrate (Tart) |
| [`@computeragent/harness-server`](packages/harness-server/) | The Hono-based server that hosts engines + substrates |
| [`@computeragent/engine-claude-agent-sdk`](packages/engine-claude-agent-sdk/) | Engine wrapping `@anthropic-ai/claude-agent-sdk` |
| [`@computeragent/engine-gitagent`](packages/engine-gitagent/) | Engine wrapping `gitclaw` (any OpenAI-compatible upstream) |
| [`@computeragent/engine-deepagents`](packages/engine-deepagents/) | Engine wrapping LangChain `deepagents` |
| [`@open-gitagent/agent-registry-mongo`](packages/agent-registry-mongo/) | `MongoTelemetry` + Mongo-backed `AgentRegistry` |
| [`@open-gitagent/session-store-mongo`](packages/session-store-mongo/) | Mongo `SessionStore` |
| [`@computeragent/session-store-sqlite`](packages/session-store-sqlite/) | SQLite `SessionStore` |
| [`@computeragent/observability`](packages/observability/) | `configureOtel()` + `OtelAuditSink` (gen_ai.* spans) |
| [`@computeragent/observability-api`](packages/observability-api/) | Express read API over ClickHouse — backs the AgentOS Observability tab |
| [`@computeragent/llm-proxy-openai`](packages/llm-proxy-openai/) | Anthropic Messages ↔ OpenAI Chat Completions translator proxy |
| [`@computeragent/identity-gitagentprotocol`](packages/identity-gitagentprotocol/) | Default `IdentityLoader` — clones GAP repos, applies subagent overlays |
| [`@computeragent/testing`](packages/testing/) | Table-driven conformance suite for third-party engines + substrates + stores |
| [`@computeragent/cli`](packages/cli/) | CLI |
| [`computeragent`](packages/computeragent/) | The umbrella entry point — re-exports SDK + `LocalSubstrate` |
| [`create-computeragent`](packages/create-computeragent/) | `npx create-computeragent my-agent` scaffolder |

---

## Versioning

Public packages follow **semver** and are independently published. The umbrella `computeragent` is currently at **`0.2.x`** — minor versions may include breaking changes until `1.0`. Pin a major if stability matters.

Wire-protocol changes are versioned separately: events carry a `protocolVersion` field; the harness server rejects requests from incompatible client versions with `HarnessProtocolError` rather than malforming.

---

## See also

- [`README.md`](README.md) — install + quickstart + "why ComputerAgent"
- [`packages/computeragent/info.md`](packages/computeragent/info.md) — architecture deep-dive + diagrams
- [`CHANGELOG.md`](CHANGELOG.md) — release notes
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — repo conventions, test guidelines, PR flow
- [`SECURITY.md`](SECURITY.md) — disclosure process

Issues + discussions: [github.com/open-gitagent/ComputerAgent](https://github.com/open-gitagent/ComputerAgent).
