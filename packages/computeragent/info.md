# info — architecture & non-obvious bits

A guided tour of the parts of ComputerAgent that read interesting in a slide deck, a talk, or a HN comment. Sibling to `README.md` (which is the "how do I use this" intro). This file is the "what's actually going on under the hood" companion.

---

## TL;DR — four orthogonal ports

ComputerAgent decomposes the agent stack into four pluggable axes. Every axis is one TypeScript interface; you swap any one without touching the others.

```
                                ┌───────────────────────────────────┐
                                │            ComputerAgent          │
                                │       (one constructor call)      │
                                └──────────────┬────────────────────┘
                                               │
                ┌──────────────┬───────────────┼───────────────┬───────────────┐
                │              │               │               │               │
                ▼              ▼               ▼               ▼               ▼
            WHAT             HOW             WHERE          REMEMBER         AUDIT
        IdentityLoader   EngineDriver      Substrate     SessionStore     AuditSink
            (agent)        (loop)           (sandbox)      (memory)       (telemetry)

   GAP git repo |       claude-agent-sdk |  Local      |  in-memory   |  Mongo
   inline yaml  |       deepagents       |  Bwrap      |  file/jsonl  |  OTel + ClickHouse
   local folder |       gitagent         |  E2B        |  Mongo       |  Honeycomb / Datadog
                                          VZ/Tart      |  SQLite      |  console
```

Five interfaces. The fifth — `AuditSink` — sits on top of the SDK rather than inside ComputerAgent's constructor (it's wired explicitly by callers that want telemetry), but it's the same shape: one method, one swap.

---

## 1. Git URL is the agent identity

Most agent frameworks invent a registry (UUIDs, names, versions). ComputerAgent collapses that:

```ts
new ComputerAgent({
  source: { type: "git", url: "github.com/acme/triage-agent" }
})
```

The git URL **is** the canonical name. Versioning is `?ref=v1.2` or a commit SHA. Discovery is `git clone`. The Mongo `agent_registry` is a cache + telemetry index — **not** the source of truth. You can delete the entire registry and re-create it by running agents.

Implication: agents share an identity across every machine that runs them. The same git URL fired from a customer's Temporal worker and from your laptop writes to the **same** `agent_logs` document. Cross-machine deduplication, free.

---

## 2. Substrate-agnostic agent code

The agent doesn't know — or care — where it runs:

| Substrate | What it actually is | Use when |
|---|---|---|
| `LocalSubstrate` | A subprocess on the same host | dev, library-mode (in someone's existing worker) |
| `BwrapSubstrate` | Linux user-namespaces (bubblewrap) | "isolation without containers" — fast, ~ms startup |
| `E2BSubstrate` | Firecracker microVM in the cloud | strong isolation, untrusted code |
| `VZSubstrate` | Apple VZ.framework via Tart | macOS-native VM, full OS + persistent disk |

```ts
new ComputerAgent({
  source: { type: "git", url: "..." },
  runtime: new LocalSubstrate(),       // ← only the deploy story changes
});
```

You change one constructor arg. Not the agent. Not the harness. Not the tools. There's a **substrate × source × engine matrix test** that fires every cell of the grid — adding a new substrate adds one column, not three months of edge-case chasing.

---

## 3. Harness protocol — the layer most frameworks don't have

Between "the SDK calling Anthropic" and "the substrate running it" there's a **harness** boundary. It's a tiny HTTP server (Hono on Bun/Node) speaking SSE + plain JSON, and it's the thing that makes claude-agent-sdk, gitagent, and deepagents fungible.

```
   Client (SDK)                       Harness                     Engine
        │                                │                          │
        │  POST /v1/sessions             │                          │
        │  { source, harness, runtime }  │                          │
        │ ─────────────────────────────▶ │                          │
        │                                │  EngineDriver.startSession
        │                                │ ──────────────────────▶  │
        │                                │                          │
        │  Content-Type: text/event-stream                          │
        │ ◀───────────────────────────── │                          │
        │  event: ca_session_started     │                          │
        │  data: { sessionId, engine }   │ ◀─── EngineEvent stream  │
        │                                │                          │
        │  event: sdk_message            │ ◀── { type: "assistant" }│
        │  event: ca_permission_request  │                          │
        │  POST /v1/sessions/:id/permission/:callId                 │
        │  { decision: "allow" }         │                          │
        │ ─────────────────────────────▶ │                          │
        │                                │                          │
        │  event: ca_usage_snapshot      │                          │
        │  event: ca_session_ended       │                          │
        │ ◀───────────────────────────── │                          │
```

The wire is documented under `packages/protocol/src/` and verified by a Zod-schema test suite (`harness-rest.test.ts`, `sse-events.test.ts`). `curl` can drive every endpoint. No proprietary RPC.

### Why a separate harness process?

Three reasons that compound:

1. **Engine portability.** claude-agent-sdk wants `$HOME/.claude/projects/*.jsonl`. gitclaw wants `$GITCLAW_MODEL_BASE_URL`. deepagents is built on LangChain. Wrapping each in a uniform `EngineDriver` interface and putting them all behind one HTTP shape means the client SDK never speaks engine-specific dialects.

2. **Substrate boundary == process boundary.** When you swap from `LocalSubstrate` to `E2BSubstrate`, the harness moves to a different machine. Same wire protocol, different physical location. Your SDK code doesn't notice.

3. **Resumability.** Every SSE event has a monotonic `id`. If the client disconnects, it reconnects with `Last-Event-ID: <last-id>` and the harness server replays from a per-session ring buffer (default: last 1,000 events or 5 minutes). Critical when running over flaky networks.

### Harness events (the wire protocol)

```ts
type HarnessEvent =
  | { kind: "ca_session_started";    sessionId; engine; identity; capabilities }
  | { kind: "sdk_message";           sessionId; payload }            // engine-native
  | { kind: "ca_permission_request"; sessionId; callId; toolName; input; risk }
  | { kind: "ca_permission_decision";sessionId; callId; decision; reason? }
  | { kind: "ca_turn_started";       sessionId; userTextLen? }
  | { kind: "ca_usage_snapshot";     sessionId; inputTokens?; outputTokens?;
                                     costUsd?; costSemantic? }       // see §6
  | { kind: "ca_session_ended";      sessionId; reason; errorMessage? };
```

`sdk_message.payload` is **opaque** — it's whatever the engine's native message shape is. The client SDK doesn't try to normalize it; the engine knows how to emit, the consumer knows how to consume.

---

## 4. AuditSink — telemetry as a protocol

There's no logger interface and no metrics interface. There's `AuditSink`:

```ts
interface AuditSink {
  emit(event: AgentEvent): Promise<void> | void;
}
```

One method. Plug in any of:

- `MongoTelemetry` — persists turn history to `agent_registry` + `agent_logs`
- `OtelAuditSink` — emits `gen_ai.*` OpenTelemetry spans → OTLP → ClickHouse / Datadog / Honeycomb / your APM
- `console` — dev
- Chain them: `[mongoSink, otelSink, consoleSink]` — the SDK fires `emit()` on each, fire-and-forget

We were early adopters of the **OpenTelemetry `gen_ai.*` semantic conventions** — `gen_ai.system`, `gen_ai.request.model`, `gen_ai.usage.input_tokens`, `gen_ai.response.cost_usd`. So your existing Grafana board built for OTel renders agent traffic out of the box.

> AuditSink is fire-and-forget by contract. The SDK catches thrown errors and never propagates them up. Telemetry must never break an agent run.

---

## 5. Library-mode vs server-mode

Most agent platforms force you into their server. ComputerAgent has **two equally first-class modes**:

```
   server-mode                              library-mode
   ────────────                             ────────────
   your customers ──→ AgentOS UI            your existing worker
                  ──→ computeragent-server       imports `computeragent`
                  ──→ harness                    imports it
                  ──→ Anthropic                  imports it
                                                 └→ harness ──→ Anthropic

   (new pods, new auth, new ingress)        (zero new infra)
```

For customers who already run Temporal / Airflow / their own job runner, library-mode means **no new pods, no new auth surface, no new ingress** — their existing worker becomes the agent runner. The de-risk spike (`spike/temporal-k8s-localsubstrate/REPORT.md`) demonstrates 7.3s end-to-end Claude turn from inside a Temporal activity in a K8s pod with no `Service`, no `Ingress`, no new RBAC.

---

## 6. Cost semantics — the subtle bit

`ChatHandle` aggregates per-message usage snapshots into a single `ChatResult.usage`. Tokens always SUM. Cost depends on the **engine's `costSemantic`**:

| Semantic | Engine | Aggregation |
|---|---|---|
| `cumulative` | claude-agent-sdk | take the **MAX** value seen (each snapshot is a running total) |
| `delta` | gitclaw | **SUM** per-message deltas |
| `undefined` | legacy | treat as cumulative (safe — never double-count) |
| mixed (defensive) | hypothetical chained engines | prefer cumulative |

This is the kind of invariant that is easy to get subtly wrong with no live harness — so it's nailed down by 7 dedicated unit tests in `packages/sdk/src/chat-handle.test.ts`.

---

## 7. JSONL session replay (auditor-friendly by accident)

claude-agent-sdk persists each session as a JSONL file in `~/.claude/projects/<encoded>/<session-id>.jsonl`. Append-only, plain text, one event per line. We didn't invent this — but two things fall out for free:

- **Resumable across crashes** — restart the worker, replay the JSONL, continue
- **Audit trail with no extra plumbing** — `grep`, `jq`, ship to S3. Compliance team smiles.

The dashboard reads these directly when you click into a session — no proprietary log store.

---

## 8. SessionStore — swappable conversation memory

Replace `agent.sessionStore` with one constructor arg:

| Kind | Backend | Use |
|---|---|---|
| `"memory"` | in-process map | dev / tests |
| `"file"` | JSONL on disk | local persistence, no infra |
| `"mongo"` | MongoDB collection | shared memory across worker pods |
| `"sqlite"` | local SQLite file | embedded, queryable, fast |

```ts
new ComputerAgent({
  source: { type: "git", url: "..." },
  sessionStore: { kind: "mongo", options: { url: MONGO_URL, database: "agentos" } },
});
```

Same SDK call. The engine doesn't know which backend is in play. **Resume across process restart, host change, substrate teardown** is built-in — not a per-integration manual replay job.

---

## 9. IRSA, no static AWS keys

For Bedrock, every other framework's instructions tell you to set `AWS_ACCESS_KEY_ID` in the pod env. We refuse to do that.

Instead, the pod's ServiceAccount has an `eks.amazonaws.com/role-arn` annotation. The AWS SDK's default-credential-chain finds `AWS_ROLE_ARN` + `AWS_WEB_IDENTITY_TOKEN_FILE` (auto-injected by the EKS pod-identity webhook), assumes the role, and Bedrock calls just work.

The harness explicitly allow-lists those env vars from the host process to the engine subprocess (see `engine-claude-agent-sdk/src/engine.ts:inheritEssentialHostEnv`). The 9 keys it passes:

```
CLAUDE_CODE_USE_BEDROCK
AWS_REGION
AWS_DEFAULT_REGION
AWS_BEDROCK_MODEL_ID
AWS_ROLE_ARN                       ← IRSA-injected
AWS_WEB_IDENTITY_TOKEN_FILE        ← IRSA-injected
AWS_PROFILE
AWS_SHARED_CREDENTIALS_FILE
AWS_CONFIG_FILE
```

Empirically verified in the spike: `bedrock-2023-05-31` invoke against Claude Haiku 4.5 in us-east-2, 7.3s, $0.035, `is_error: false`. No static keys anywhere in the cluster.

---

## 10. Permission protocol — every tool call is auditable

Every `Bash`, `Read`, `Edit` call by an agent goes through a permission check that emits a `ca_permission_decision` event. This event includes:

- the tool name
- the tool arguments (`Bash` command, `Read` path)
- the decision (`allow` / `deny` / `ask`)
- *why* (the matching policy rule, if any)

```
  engine                  harness                  client (or policy decider)
     │                        │                            │
     │  permission_request    │                            │
     │ ──────────────────────▶│                            │
     │                        │  ca_permission_request     │
     │                        │  (SSE event)               │
     │                        │ ─────────────────────────▶ │
     │                        │                            │
     │                        │  POST /permission/:callId  │
     │                        │  { decision: "allow" }     │
     │                        │ ◀──────────────────────────┤
     │  PermissionResult      │                            │
     │ ◀──────────────────────┤                            │
     │                        │  ca_permission_decision    │
     │                        │  → AuditSink               │
```

The harness can short-circuit: if there's an in-process `PolicyDecider` (Cedar/OPA via SRS), the harness resolves the decision without a client round-trip. Same wire event still flows to `AuditSink` for the audit trail.

Pipe `ca_permission_decision` events into your SIEM and you have full audit-replay for every agent action.

---

## 11. Conformance suite for third-party plug-ins

`@computeragent/testing` exports a **table-driven conformance suite** that any third-party `EngineDriver` / `Substrate` / `SessionStore` implementation can run against itself:

```ts
import { runEngineConformance } from "@computeragent/testing";

runEngineConformance(myCustomEngine, {
  capabilities: { streamingInput: true, permissionCallback: true, /* … */ },
});
```

The suite asserts: engine emits the right events in the right order, respects abort signals, surfaces tool calls through the permission protocol, doesn't crash on empty input. About 30 invariants. Plug-in authors discover protocol violations at `vitest run`, not in production.

---

## 12. OTLP everywhere, vendor nowhere

The harness exports OTel via plain `OTEL_EXPORTER_OTLP_ENDPOINT`. That's it. The harness doesn't know:

- ❌ "We use Datadog"
- ❌ "We use ClickHouse"
- ❌ "We use Honeycomb"

It knows: "POST traces to this URL." An OTel Collector sitting next to it does the demux. Your vendor of choice is a collector config away — no recompilation, no harness restart, no new code path.

---

## End-to-end flow — a single chat turn

The pieces above tied together, for one `agent.chat("hello")` call against a remote E2B substrate:

```
   1. agent.chat("hello")
            │
            ▼ POST {harnessUrl}/v1/sessions
        ┌──────────────────────────────────┐
        │  Substrate (E2B microVM, remote) │
        │  ┌────────────────────────────┐  │
        │  │   Harness server (Hono)     │  │
        │  │   ┌──────────────────────┐  │  │
        │  │   │  EngineDriver        │  │  │ 2. starts session
        │  │   │  (claude-agent-sdk)  │  │  │ 3. invokes Claude API
        │  │   │  + AuditSink chain   │  │  │
        │  │   └─────┬────────────────┘  │  │
        │  │         │                   │  │
        │  └─────────┼───────────────────┘  │
        └────────────┼─────────────────────┘
                     │
                     ▼  SSE: ca_session_started, sdk_message, ca_usage_snapshot, ca_session_ended
            ┌────────────────────┐
            │  ChatHandle        │  5. yields raw events as `for await of handle`
            │  (client SDK)      │  6. drains to ChatResult on `await handle`
            └────┬───────────────┘
                 │
                 ├─→ MongoTelemetry  (agent_logs row)
                 └─→ OtelAuditSink   (gen_ai.* spans → OTel Collector → ClickHouse)

   4. Engine fires AuditSink.emit() on every event, fire-and-forget.
```

The interesting part is how little of this the **agent code** has to know. The agent's `agent.yaml` + `SOUL.md` files (its GAP manifest) describe what it does. ComputerAgent figures out where to run it, who tracks it, and how its output gets to the dashboard.

---

## See also

- [`README.md`](README.md) — install + quickstart
- [`packages/protocol/`](../protocol/) — the wire-protocol schemas, Zod-validated
- [`packages/sdk/src/chat-handle.ts`](../sdk/src/chat-handle.ts) — the client-side stream wrapper covered in §6
- [`packages/engine-claude-agent-sdk/`](../engine-claude-agent-sdk/) — the reference `EngineDriver` implementation
- [`packages/harness-server/`](../harness-server/) — the Hono server that hosts engines + substrates
- [`@open-gitagent/agent-registry-mongo`](../agent-registry-mongo/) — the first-class `MongoTelemetry` + `AuditSink` impl
- [`spike/temporal-k8s-localsubstrate/REPORT.md`](https://github.com/open-gitagent/enterprise-computeragent/blob/main/spike/temporal-k8s-localsubstrate/REPORT.md) — library-mode under Temporal + K8s (de-risk spike, runs live)
