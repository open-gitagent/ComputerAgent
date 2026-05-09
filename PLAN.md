# ComputerAgent SDK — Architecture & Plan (rev 4)

> **Rev 4 changes:** Codified engineering principles (SOLID + design patterns + code rules). Tightened Wedge 1 to a true MVP with explicit build sequence — skeleton first, working curl demo second, polish (replay buffer, audit, auth, full conformance suite) third. Several originally-Wedge-1 features moved to Wedge 1.5 to keep first-ship lean.
>
> **Rev 3 (preserved):** Build order inverted. **The reusable Harness Server module ships first** as a generic SSE+POST framework with two pluggable interfaces (`EngineDriver`, `IdentityLoader`). Claude Agent SDK and gitagent (GAP/gapman) are the first plug-ins, not built-in.
>
> **Rev 2 (preserved):** Transport pinned to **SSE + POST** (not WebSocket). `engine-claude-agent-sdk` is built on the real `@anthropic-ai/claude-agent-sdk` v0.2.132 — direct import, no CLI / stdout parsing. Inherits `SessionStore`, `canUseTool`, partial-message streaming, and budget caps from the SDK.

## Context

Today's agent stack conflates three concerns that should be orthogonal:

1. **Identity** — who the agent is (prompts, rules, tools, compliance, skills)
2. **Loop** — the agentic engine that turns prompts → tool calls → outputs (Claude Code, Codex, OpenCode, Gemini CLI, gitclaw, …)
3. **Substrate** — where the OS-level work happens (local shell, E2B, Lyzr Compute, Modal, Daytona, …)

GitAgentProtocol (GAP) v0.1.0 cleanly solved (1) — a portable, git-native, framework-agnostic agent definition. It also has scaffolding for (2) via `gapman run --adapter` but doesn't standardize (3) at all.

`ComputerAgent` is the SDK that completes the picture: a single calling convention that takes a GAP repo and runs it under any *harness* on any *runtime*. **Agents become Docker-shaped** — a portable image (GAP repo), a swappable engine (harness), and a swappable host (runtime).

## Vision

```
const agent = new ComputerAgent({ source, envs, sessionId, harness, runtime })
                                    │              │           │        │
                                    │              │           │        └─ WHERE (substrate)
                                    │              │           └─────────── HOW   (agentic loop)
                                    │              └─────────────────────── STATE (session handle)
                                    └────────────────────────────────────── WHAT  (identity = GAP repo)

agent.chat(messages) → AsyncIterable<HarnessEvent> & Promise<ChatResult>
            │
            └─ INVOKE (per-turn input; sync array, single message, or AsyncIterable)
```

**Constructor configures the agent.** `.chat()` invokes it. Multiple `.chat()` calls on the same agent share a session — each call is a turn in the same conversation.

**Positioning.** *"Run any GAP agent, anywhere, with any loop."* The novel artifact is not the SDK itself — it's the two protocols underneath it that turn harnesses and runtimes into pluggable commodities. SDK is the reference client; the protocols are the standard. Comparable: LSP (editors ↔ language servers), MCP (LLMs ↔ tools), OCI (registries ↔ runtimes).

## Engineering Principles

This codebase is held to a small set of rules. Every module honors them; reviews enforce them.

### SOLID, applied to this architecture

- **Single Responsibility.** Every package owns one concern; every file ≤ 250 LOC; every class ≤ 5 public methods. If a module grows past those thresholds, split it. Examples in this repo:
  - `Session` only holds per-session state. SSE serialization, replay, and routing live in separate files.
  - `IdentityLoader` translates; the engine consumes; neither knows the other's internals.
- **Open/Closed.** New engines and loaders are added by *implementing an interface*, never by modifying `harness-server`. The framework is closed to modification, open to extension.
- **Liskov Substitution.** Any `EngineDriver` works wherever any other does. The conformance suite is the LSP enforcer — failing it = breaking substitution.
- **Interface Segregation.** Small interfaces. `EngineDriver` is 2 fields + 1 method. `IdentityLoader` is 1 method. `SessionStore` (re-exported from claude-agent-sdk) is 4 methods. Never bundle unrelated concerns.
- **Dependency Inversion.** `harness-server` imports *types only* from `@computeragent/protocol`, never concrete plug-ins. Plug-ins are wired by the user at server boot. There is no `import { ClaudeAgentEngine } from "engine-claude-agent-sdk"` anywhere inside `harness-server`.

### Design patterns we use deliberately

| Pattern | Where | Why |
|---|---|---|
| **Strategy** | `EngineDriver`, `IdentityLoader`, `SessionStore`, `AuthHandler`, `AuditSink` | Pluggable behavior; swap at boot |
| **Adapter** | `identity-gitagentprotocol`'s per-engine adapters (`gapToClaudeAgentOptions`, future `gapToCodexOptions`, …) | One loader fans out to many engine targets |
| **Factory** | `createHarnessServer({...})`, `Session.create()` | Hide construction; centralize defaults; return interface, not class |
| **Registry** | `SessionRegistry` (in-memory map + TTL) | Lookup by id; lifecycle owner |
| **Observer / event stream** | `AsyncIterable<EngineEvent>` from engines, SSE stream to client | Push-based, backpressure-friendly, cancelable via abort |
| **Command** | One thin route handler per REST endpoint, dispatching to a service method | Routes stay dumb; logic stays unit-testable without HTTP fixtures |
| **Ports & adapters (hexagonal)** | `harness-server` is the hexagon; `EngineDriver`/`IdentityLoader`/`SessionStore` are ports; concrete plug-ins are adapters | Whole architecture |
| **`Promise.withResolvers`** | Permission round-trip plumbing | Server holds open promise until client POSTs decision |
| **Ring buffer** | Per-session SSE replay buffer (Wedge 1.5) | `Last-Event-ID` resume without unbounded memory |

### Code rules

1. **No file over 250 LOC.** Hard cap. When a file approaches the cap, split by responsibility.
2. **No abstraction without a second consumer.** YAGNI is non-negotiable. We do not add a strategy interface for "future-proofing" — only when the second concrete implementation is on the same PR or imminently next.
3. **Pure functions for translations.** `gapToClaudeAgentOptions`, SSE event serialization, schema parsing — all pure. Side-effects (fs, network) live at the *edges* of routes.
4. **Errors are values at boundaries.** Validation returns `Result<T, ValidationError>`, not throws. Inside the request lifecycle, throws are mapped to typed HTTP responses by one error-mapper middleware.
5. **Zod at the wire, types inside.** All inbound HTTP and outbound SSE bodies pass through zod. Internal code uses inferred types and trusts them — no defensive re-validation.
6. **No `any`.** Use `unknown`, narrow before use. The TypeScript compiler is the second reviewer.
7. **No `console.log`; structured logging only.** `pino` with levels. No log lines on hot paths.
8. **Tests live next to source.** `foo.ts` + `foo.test.ts`. Vitest. Snapshots only for translation outputs (deterministic).
9. **No emojis in source, logs, or generated output.** Plain text everywhere.
10. **Imports go down the dependency graph.** `engine-*` and `identity-*` import from `protocol`. `harness-server` imports only from `protocol`. No cross-imports between engine and identity packages.
11. **No barrel re-exports for internals.** Each package's `src/index.ts` exports only its public surface. Internals stay internal.
12. **Boring tech.** `hono`, `zod`, `pino`, `vitest`, `tsup` (or `tsc`). No experimental frameworks; we want the standard to outlive us.

### Definition of "done" for any module

- Unit tests pass with ≥ 80% line coverage on logic (skip dumb wiring).
- Public API has a JSDoc one-liner per export.
- No file > 250 LOC.
- Typecheck clean with `strict: true` and `noUncheckedIndexedAccess: true`.
- One example or test that exercises the happy path end-to-end.

## Core Architecture: Two Stacked Protocols

```
   ┌────────────────────────────────────────────────────────────────┐
   │  User's TypeScript code                                        │
   │      import { ComputerAgent } from "@computeragent/sdk";       │
   └────────────────────────────────────────────────────────────────┘
                              │
                              │  Harness Protocol  (SSE + POST over HTTP/2)
                              │  ────────────────────────────────────
                              │   Client → Server (POST):
                              │     /v1/sessions, /messages, /permission, /cancel
                              │   Server → Client (SSE):
                              │     sdk_message events  (forwarded SDKMessage union)
                              │     ca_*  events        (ComputerAgent framing layer)
                              ▼
   ┌────────────────────────────────────────────────────────────────┐
   │  Harness Server  (runs INSIDE the runtime, port :7700)         │
   │   • Materializes GAP repo on disk (clone or unpack)            │
   │   • Translates GAP manifest → harness-native options           │
   │   • Calls underlying agent loop (e.g., claude-agent-sdk.query) │
   │   • Forwards yielded messages over SSE; receives input via POST│
   │   • Distributed as Docker image: computeragent/harness-<name>  │
   └────────────────────────────────────────────────────────────────┘
                              │
                              │  Substrate Protocol
                              │  ────────────────────────────────────
                              │   exec / fs / port_forward / lifecycle
                              ▼
   ┌────────────────────────────────────────────────────────────────┐
   │  Substrate (local subprocess | e2b | lyzrcompute | …)          │
   └────────────────────────────────────────────────────────────────┘
```

## Why SSE + POST (not WebSocket)

The harness is **half-duplex by nature**: the server emits a high-volume event stream; the client occasionally injects user messages or permission decisions. SSE matches this shape exactly.

| Concern | SSE + POST | WebSocket |
|---|---|---|
| Native browser support | ✅ `EventSource` | Needs library |
| HTTP/2 multiplexing | ✅ | ❌ (HTTP/1.1 upgrade) |
| Reconnect with replay | ✅ `Last-Event-ID` header (built into spec) | Manual sequence-tracking |
| Reverse proxy / CDN friendly | ✅ Cloudflare, Vercel, Cloud Run all support | Often blocked or expensive |
| Debuggable with `curl` | ✅ | ❌ (need `wscat`) |
| Server libs (Node) | `fastify-sse-v2`, `hono/streaming` — boring, mature | `ws` works but more state |
| Auth | Standard HTTP headers/bearer/cookies | Same, plus subprotocol fiddling |
| Mirrors Anthropic API streaming | ✅ Same wire format | Different |

**The Anthropic Messages API itself streams over SSE.** When `includePartialMessages: true`, the Claude Agent SDK exposes `SDKPartialAssistantMessage` with raw `BetaRawMessageStreamEvent` deltas — those are SSE events from the LLM API. By using SSE end-to-end, our wire format stays homogeneous from LLM → SDK → harness-server → client.

**Resumability.** Each SSE event has a monotonic `id`. If the client disconnects, it reconnects with `Last-Event-ID: <last-id>` and the harness server replays from a per-session ring buffer (default: last 1,000 events or 5 minutes). This is critical when running on lyzrcompute or E2B over flaky networks.

## The Harness Protocol (concrete)

The protocol exposes **two parallel surfaces** at the same paths so a user can pick the model that fits their use case:

- **`/v1/chat`** — one-shot convenience. *One POST, one SSE response.* The server creates the session internally, runs the agent to completion (or until disconnect), and cleans up. This is the 80% case: chat UIs, automation scripts, single-prompt jobs. Mental model: same as OpenAI / Anthropic chat-completions, but the response stream is the full agentic event sequence, not just text deltas.
- **`/v1/sessions`** — long-lived primitive. Explicit session lifecycle. Use when you need mid-flight control: queueing follow-up messages over hours, interrupting a long-running agent, attaching multiple clients to one session, fine-grained permission round-trips with human approval, cancel + resume.

`/v1/chat` is implemented internally as `POST /sessions` + auto-`GET /events` + auto-`DELETE` on stream end. There is no behavioral divergence between them — same engine, same loader, same SSE event types. The convenience endpoint is sugar.

### `POST /v1/chat` — one-shot (the 80% case)

```
POST /v1/chat
Headers: Content-Type: application/json
         Accept: text/event-stream
Body:    {
           engine: "claude-agent-sdk",
           identity: {
             loader: "gitagentprotocol",
             source: { type: "git", url } | { type: "local", path } | { type: "inline", manifest, files }
           },
           envs?: { ANTHROPIC_API_KEY: "..." },
           messages?: [{ role: "user", content: string | ContentBlock[] }],
           options?: {                       # optional engine-level overrides
             model, maxTurns, permissionMode, includePartials, maxBudgetUsd, ...
           },
           sessionId?: string                # if provided, server reuses; else generates
         }
Resp:    text/event-stream                   # the SSE stream IS the response body
         # First event always carries the sessionId so a client can still POST to
         # /v1/sessions/:id/permission or /cancel mid-stream if needed.
```

Curl example:
```bash
curl -N -X POST http://127.0.0.1:7700/v1/chat \
  -H "Content-Type: application/json" \
  -d '{
    "engine": "claude-agent-sdk",
    "identity": { "loader": "gitagentprotocol", "source": { "type": "git", "url": "github.com/open-gitagent/gitagent-protocol/examples/standard" } },
    "envs": { "ANTHROPIC_API_KEY": "sk-..." },
    "messages": [{ "role": "user", "content": "Review the README for inconsistencies" }],
    "options": { "maxTurns": 20 }
  }'
```

This single command boots a session, drives the full agentic loop, and streams every SDK message + ComputerAgent framing event back. When the agent emits `result`, the server emits `ca_session_ended` and closes the stream.

### Session API — long-lived primitive

```
POST   /v1/sessions
Body:  same shape as /v1/chat body (without `messages` if you want to start empty)
Resp:  { sessionId, engine, identity: { name, version, sha }, capabilities, eventsUrl }

GET    /v1/sessions/:id/events               # SSE — open separately
Headers: Accept: text/event-stream
         Last-Event-ID: <opt — Wedge 1.5 for resume>

POST   /v1/sessions/:id/messages
Body:  { message: { role: "user", content: string | ContentBlock[] } }
Resp:  { ack: true, messageId }              # pushes onto the engine's user-message queue

POST   /v1/sessions/:id/permission/:callId
Body:  { decision: "allow" | "deny" | "modify", input?: any, reason?: string }
Resp:  { ack: true }

POST   /v1/sessions/:id/cancel
Resp:  { ok: true }                          # AbortController.abort() upstream

DELETE /v1/sessions/:id
Resp:  { ok: true }                          # releases resources

GET    /v1/sessions/:id                      # metadata only (status, usage so far)
GET    /v1/health                            # { ok, version, engines: {...capabilities}, loaders: [...] }
```

### Implementation note (Wedge 1)

Both surfaces share the same underlying `Session` + `SessionRegistry` machinery. `POST /v1/chat` is implemented in `src/routes/chat.ts` as a thin handler that:

1. Calls the same `createSession` service the session route uses.
2. Pipes the SSE encoder directly into the response body (instead of buffering and returning a sessionId).
3. Registers an `AbortSignal` on the response stream so client disconnect aborts the engine.
4. Auto-deletes the session from the registry when the stream completes or the client disconnects.

This is ~40 LOC. No duplicated logic; just a different transport of the same plumbing. Ports & adapters in action.

### Filesystem API — the session workdir over HTTP

Every session has a **workdir** — the directory the agent runs in, where it reads, writes, and edits files. Exposing that workdir through HTTP turns the harness server from "agent event router" into "complete agent workspace exposed over an API." Same category as Codespaces / Replit / E2B, but agent-shaped.

All paths are **jailed** to the session's workdir. Absolute paths, `..` traversal, and symlinks pointing outside the workdir are rejected with `400 PATH_ESCAPE`. Auth is loopback-only in MVP; pluggable `AuthHandler` lands in Wedge 1.5.

```
GET    /v1/sessions/:id/fs/tree?path=<rel>&depth=<n>
Resp:  { entries: [{ path, type: "file"|"dir", size, mtime, mode }, ...] }
       — `path` defaults to "/" (workdir root); `depth` defaults to 1.

GET    /v1/sessions/:id/fs/file?path=<rel>[&format=text|binary]
Resp:  raw bytes (Content-Type sniffed) or utf-8 text body.
       Range requests supported for large files.

PUT    /v1/sessions/:id/fs/file?path=<rel>
Body:  raw bytes
Resp:  { ok: true, sha, size }
       — Creates parent dirs if missing. Writes are atomic (tmp + rename).

POST   /v1/sessions/:id/fs/edit
Body:  { path, old_string, new_string, replace_all?: boolean }
Resp:  { ok: true, replacements }
       — Same string-replace semantics as Claude Code's Edit tool. Useful for diffs.

DELETE /v1/sessions/:id/fs/file?path=<rel>[&recursive=true]
Resp:  { ok: true }

POST   /v1/sessions/:id/fs/mkdir
Body:  { path, recursive?: boolean }
Resp:  { ok: true }

POST   /v1/sessions/:id/fs/move
Body:  { from, to }
Resp:  { ok: true }
```

**Wedge 1.5 — live workspace watch** (deferred):

```
GET    /v1/sessions/:id/fs/watch?path=<rel>
       Accept: text/event-stream
SSE:   event: fs.change
       data: { path, kind: "create"|"modify"|"delete" }
```

Pair `/fs/watch` with `/sessions/:id/events` and a client gets the **complete picture**: what the agent is *thinking* (events stream) and what it's *producing* (file changes). This is the killer DX for agent UIs — open both streams side by side.

### Architectural fit: Substrate FS port

In Wedge 1 the substrate is implicit-local — `runtime-local` is the only substrate, the workdir is a real path, FS routes call Node `fs/promises` directly. In Wedge 3 (real substrates: E2B, Lyzr Compute), the same routes call the abstract `substrate.fs.{read,write,list,…}` port. **The HTTP surface doesn't change.** Code path:

```
HTTP route (routes/fs.ts)
    ↓
service (services/workspace-fs.ts)        ← jails paths, validates input
    ↓
substrate.fs port                          ← in Wedge 1: just Node fs; in Wedge 3: pluggable
```

This keeps Wedge 1's FS implementation small (~250 LOC across route + service + path-jailer) while not painting the protocol into a corner for remote substrates.

### SSE stream (Server → Client)

```
GET /v1/sessions/:id/events
Headers: Accept: text/event-stream
         Last-Event-ID: <opt — for resume>
```

Two event families:

**`event: sdk_message`** — verbatim forwarding of the underlying SDK's message union. The data is the JSON-serialized `SDKMessage` from `@anthropic-ai/claude-agent-sdk`:

```
event: sdk_message
id: 0042
data: {"type":"assistant","uuid":"...","session_id":"...","message":{...},"parent_tool_use_id":null}

event: sdk_message
id: 0043
data: {"type":"stream_event","event":{...BetaRawMessageStreamEvent...},"parent_tool_use_id":null,...}
```

This means **clients that already know the Claude Agent SDK's types can consume our stream with zero translation**. Other harnesses (gitclaw, codex) emit their own `sdk_message` shapes; we ship typed adapters for each in `@computeragent/sdk`.

**`event: ca_*`** — ComputerAgent-level framing the underlying SDKs don't emit:

```
event: ca_session_started
data: { sessionId, harness, gap: {...}, model, capabilities: ["partials","hitl","sessions"] }

event: ca_permission_request
data: { callId, toolName, input, risk: "low|medium|high|destructive",
        gap_compliance: { framework, rule_citations? } }

event: ca_substrate_event
data: { kind: "port_forward", port, public_url }   // for serving demos out of sandboxes

event: ca_usage_snapshot
data: { input_tokens, output_tokens, cache_*, cost_usd, compute_seconds_substrate }

event: ca_session_ended
data: { reason: "complete"|"cancelled"|"error"|"budget_exceeded", final?: SDKResultMessage }
```

The `ca_*` family is **opt-in metadata layered onto SDK passthrough**. Clients that ignore these events still get a fully usable stream.

## The Harness Server: a Reusable Framework with Two Pluggable Interfaces

The Harness Server is **not bound to Claude Code or to GAP**. It's a generic SSE+POST framework for *any* agent loop driving *any* identity format. Engines and identity loaders are plug-ins that satisfy two interfaces.

```ts
// @computeragent/harness-server/src/contracts.ts

/** An EngineDriver wraps an agent loop (Claude Agent SDK, Codex, gitclaw, …). */
export interface EngineDriver<TOptions = unknown> {
  name: string;            // "claude-agent-sdk" | "codex" | "gitclaw" | …
  capabilities: {
    streamingInput: boolean;          // accepts user msgs mid-session
    partialMessages: boolean;         // emits token-level deltas
    permissionCallback: boolean;      // supports per-tool HITL
    sessions: boolean;                // resume/fork
    budget: boolean;                  // hard cost cap
  };

  startSession(ctx: EngineContext<TOptions>): AsyncIterable<EngineEvent>;
  // EngineContext bundles: options, userMessageQueue, onPermissionRequest,
  //                        abortSignal, budget, workdir, envs, sessionStore
}

/** An IdentityLoader translates a "what is this agent" source into engine options. */
export interface IdentityLoader<TOptions = unknown> {
  name: string;            // "gitagentprotocol" | "openai-assistants" | "crewai" | …

  load(args: {
    source: IdentitySource;             // git URL | local path | inline manifest
    targetEngine: string;               // engine the result must feed
    workdir: string;                    // substrate-provided dir
  }): Promise<LoadResult<TOptions>>;
  // LoadResult: { options, metadata: {name,version,sha?}, cleanup? }
}

/** Spin up a server with whatever engines + loaders you registered. */
export function createHarnessServer(config: {
  engines: Record<string, EngineDriver>;
  identityLoaders: Record<string, IdentityLoader>;
  port?: number;
  replayBufferSize?: number;            // for Last-Event-ID resume
  auth?: AuthHandler;
}): HarnessServer;
```

**Usage:**
```ts
import { createHarnessServer } from "@computeragent/harness-server";
import { ClaudeAgentEngine } from "@computeragent/engine-claude-agent-sdk";
import { GitAgentProtocolLoader } from "@computeragent/identity-gitagentprotocol";

const server = createHarnessServer({
  engines: { "claude-agent-sdk": new ClaudeAgentEngine() },
  identityLoaders: { gitagentprotocol: new GitAgentProtocolLoader() },
  port: 7700,
});

await server.listen();
```

A client POSTs:
```
POST /v1/sessions
{
  "engine": "claude-agent-sdk",
  "identity": { "loader": "gitagentprotocol", "source": { "type": "git", "url": "github.com/org/my-agent" } },
  "envs": { "ANTHROPIC_API_KEY": "sk-..." },
  "options": { "maxTurns": 50 }
}
```

The server: validates → calls `loader.load()` → calls `engine.startSession()` → forwards events over SSE. **Adding a new engine or identity format = ship a small package implementing one interface.** No fork, no upstream PR.

### What the Harness Server Owns (the value of the framework)

The framework — not the engine plug-ins — is responsible for:

1. **HTTP routing** (Hono) — `/v1/sessions`, `/messages`, `/permission`, `/cancel`, `/events`, `/health`
2. **SSE streaming** with monotonic event IDs
3. **`Last-Event-ID` replay buffer** (per-session ring buffer)
4. **Session registry** with TTLs
5. **Permission round-trip** — server holds `Promise<PermissionDecision>` open while `ca_permission_request` is on the wire; resolves when client POSTs to `/permission/:callId`
6. **Abort wiring** — `/cancel` POST → `AbortController.abort()` → engine sees `abortSignal`
7. **Budget enforcement** — wraps engine event stream; emits `ca_session_ended { reason: "budget_exceeded" }` when usage events cross threshold
8. **Audit log tee** — when configured, every SSE event is also persisted to a write-only log (substrate-mounted file, S3, etc.) for compliance
9. **Auth** — bearer / signed JWT / mTLS hooks (pluggable)
10. **Capability negotiation** — `GET /v1/health` returns the engine's `capabilities` so the client SDK can avoid asking for unsupported features

**The framework is the standard.** Engines and loaders are commodity adapters built on top.

## First Engine: `@computeragent/engine-claude-agent-sdk`

The Claude Agent SDK exposes everything we need natively. We do not parse stdout. We do not run the CLI. We `import { query } from "@anthropic-ai/claude-agent-sdk"` directly inside the engine plug-in:

```ts
// engine-claude-agent-sdk/src/index.ts (abridged)
import { query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { EngineDriver, EngineContext, EngineEvent } from "@computeragent/harness-server";

export class ClaudeAgentEngine implements EngineDriver<ClaudeAgentOptions> {
  name = "claude-agent-sdk";
  capabilities = { streamingInput: true, partialMessages: true,
                   permissionCallback: true, sessions: true, budget: true };

  async *startSession(ctx: EngineContext<ClaudeAgentOptions>): AsyncIterable<EngineEvent> {
    async function* userIter(): AsyncIterable<SDKUserMessage> {
      for await (const m of ctx.userMessageQueue) yield m;
    }

    const q = query({
      prompt: userIter(),
      options: {
        ...ctx.options,
        cwd: ctx.workdir,
        env: ctx.envs,
        includePartialMessages: true,
        abortController: ctx.abortController,
        maxBudgetUsd: ctx.budget?.maxUsd,
        sessionStore: ctx.sessionStore,
        canUseTool: async (toolName, input, opts) => {
          const decision = await ctx.onPermissionRequest({
            callId: opts.tool_use_id, toolName, input,
          });
          return decision;          // SDK's PermissionResult shape
        },
      },
    });

    for await (const msg of q) {
      yield { kind: "sdk_message", payload: msg };   // framework forwards to SSE verbatim
    }
  }
}
```

That's the whole engine. ~150 LOC including the option translation. **Future engines (Codex, gitclaw, OpenCode, Gemini) are the same shape: 100–300 LOC each.**

## First Identity Loader: `@computeragent/identity-gitagentprotocol`

Wraps `@open-gitagent/gapman` to validate a GAP repo and translate `agent.yaml` + `SOUL.md` + `RULES.md` + `skills/` + `tools/` + `compliance` into the Claude Agent SDK's `Options` shape (or any other engine's option shape via `targetEngine`).

```ts
// identity-gitagentprotocol/src/index.ts (abridged)
import { validate, materialize } from "@open-gitagent/gapman";
import type { IdentityLoader } from "@computeragent/harness-server";
import { gapToClaudeAgentOptions } from "./adapters/claude-agent-sdk";
import { gapToCodexOptions }       from "./adapters/codex";

export class GitAgentProtocolLoader implements IdentityLoader {
  name = "gitagentprotocol";

  async load({ source, targetEngine, workdir }) {
    const repoPath = await materialize(source, workdir);
    const manifest = await validate(repoPath);
    const adapter = adapters[targetEngine] ?? throwUnsupported(targetEngine);
    const options = await adapter(manifest, repoPath);
    return {
      options,
      metadata: { name: manifest.name, version: manifest.version, sha: manifest.sha },
      cleanup: async () => { /* optional unmount */ },
    };
  }
}

const adapters: Record<string, (m, p) => Promise<unknown>> = {
  "claude-agent-sdk": gapToClaudeAgentOptions,
  "codex":            gapToCodexOptions,    // future
};
```

The GAP→engine translation table from rev 2 lives inside `gapToClaudeAgentOptions`. **One IdentityLoader, multiple per-engine adapters.** A new engine joining the ecosystem can either ship its own loader or contribute an adapter to ours.

## GAP → Claude Agent SDK Options Translation

The non-trivial work in `harness-claudecode` is mapping a GAP repo to the SDK's `Options`. Owned by `@computeragent/gap-loader` (used by every harness).

| GAP source | Claude Agent SDK option | Notes |
|---|---|---|
| `agent.yaml.model.preferred` | `model` | Direct |
| `agent.yaml.model.fallback[]` | `fallbackModel` | First entry |
| `agent.yaml.model.constraints.temperature` etc. | `extraArgs` | SDK exposes via `extraArgs` for non-canonical knobs |
| `agent.yaml.runtime.max_turns` | `maxTurns` | Direct |
| `agent.yaml.runtime.timeout` | `abortController` | We set a `setTimeout(controller.abort)` |
| `SOUL.md` + `RULES.md` | `systemPrompt: { type: "preset", preset: "claude_code", append: stitched }` | Concatenate, prepend section headers |
| `AGENTS.md` | Written to `CLAUDE.md` + `settingSources: ["project"]` | Native file Claude Code already reads |
| `skills/` | Symlink/copy → `.claude/skills/` (`settingSources: ["project"]`) | Claude Code auto-discovers |
| `tools/<name>.yaml` (script impl) | Convert to `mcpServers["gap_tools"]` via `createSdkMcpServer` + `tool()` | We generate one in-process MCP server per GAP repo |
| `tools/<name>.yaml` (built-in mapping) | `allowedTools: [...]` | If `name` matches a Claude built-in (Read, Edit, …) |
| `agents/<name>/` | `agents: { <name>: AgentDefinition }` | Recursive load |
| `hooks/hooks.yaml` | `hooks: { ... }` | Direct mapping; same JSON-in/JSON-out script protocol |
| `compliance.supervision.human_in_the_loop: always` | `permissionMode: 'default'` + `canUseTool` enforced | Always prompt |
| `compliance.supervision.human_in_the_loop: none` | `permissionMode: 'bypassPermissions'` | Auto-approve (only allowed if not regulated) |
| `compliance.supervision.escalation_triggers[]` | `canUseTool` checks confidence/action_type and emits `ca_permission_request` | Caller decides |
| `compliance.supervision.kill_switch: true` | `abortController` always wired; `/cancel` POST aborts | Required |
| `compliance.recordkeeping.audit_logging: true` | Tee SSE stream to a write-only audit log inside the substrate | Substrate-level concern |
| `agent.yaml.runtime.budget_usd` (proposed) | `maxBudgetUsd` | Hard-capped by SDK |

**Key insight:** the GAP `compliance` block is *enforceable* because the Claude Agent SDK exposes the right primitives. `human_in_the_loop: always` becomes mandatory `canUseTool` interception. `kill_switch` becomes a wired `abortController`. `budget` becomes `maxBudgetUsd`. The compliance contract of GAP isn't decorative — it has runtime teeth.

## Module Layout (TypeScript monorepo, pnpm + turbo)

**Tier 1 — The Standard (what ships first):**
```
@computeragent/protocol                # Type defs + zod schemas + JSON schemas
                                       # — Harness Protocol (REST endpoints + SSE event union)
                                       # — Substrate Protocol (exec, fs, lifecycle)
                                       # — EngineDriver + IdentityLoader interfaces
                                       # — Re-exports SDKMessage from claude-agent-sdk
                                       #   (only used when payload is forwarded as-is)

@computeragent/harness-server          # The reusable framework — heart of the project
                                       # — HTTP routing (hono) + SSE streaming
                                       # — Last-Event-ID replay buffer
                                       # — Session registry + TTLs
                                       # — Permission round-trip plumbing
                                       # — Abort + budget wiring
                                       # — Audit-log tee
                                       # — Capability negotiation
                                       # — NO engine, NO loader bound — pure framework
```

**Tier 2 — First Plug-ins:**
```
@computeragent/engine-claude-agent-sdk # Implements EngineDriver
                                       # Wraps query() from @anthropic-ai/claude-agent-sdk
                                       # — ~150 LOC

@computeragent/identity-gitagentprotocol       # Implements IdentityLoader
                                       # Wraps @open-gitagent/gapman
                                       # — Source resolution (git/local/inline)
                                       # — Per-target-engine adapters (Claude SDK, Codex, …)
```

**Tier 3 — Client + Substrates + Surface:**
```
@computeragent/sdk                     # User-facing client
                                       # — ComputerAgent class
                                       # — SSE client w/ Last-Event-ID resume
                                       # — Streaming events as AsyncIterable
                                       # — Permission callback wiring
                                       # — Re-exports SessionStore from claude-agent-sdk

@computeragent/cli                     # Thin CLI wrapper (citty)

@computeragent/runtime-local           # Substrate: child_process + fs
                                       # — Spawns harness-server as subprocess
                                       # — No Docker required for dev

@computeragent/runtime-e2b             # Substrate: @e2b/sdk wrapper
                                       # — Pulls/runs harness image in sandbox
                                       # — port_forward via getHost()

@computeragent/runtime-lyzrcompute     # Later
```

**Tier 4 — Future Plug-ins (not us, the ecosystem):**
```
@computeragent/engine-gitclaw          # Your harness
@computeragent/engine-codex            # OpenAI Codex CLI / SDK
@computeragent/engine-opencode         # OpenCode
@computeragent/engine-gemini-cli       # Google Gemini CLI
@computeragent/identity-openai-assistants  # OpenAI Assistants spec
@computeragent/identity-crewai         # CrewAI YAML
```

**Tier 5 — Testing:**
```
@computeragent/testing                 # Mock substrate + mock engine + mock loader
                                       # — Conformance suite engine/loader authors run
                                       # — Same suite ComputerAgent CI runs against itself
```

## Public API (TypeScript)

```ts
import { ComputerAgent } from "@computeragent/sdk";

// ── Configure the agent (constructor = identity + engine + runtime + policy) ──
const agent = new ComputerAgent({
  source: "github.com/org/my-agent",            // GAP repo: URL | path | inline
  envs: { ANTHROPIC_API_KEY: "sk-..." },
  sessionId: "abc-123",                         // optional; auto-generated if omitted
  harness: "claude-agent-sdk",                  // or "gitclaw", "codex", …
  runtime: "local",                             // or "e2b", "lyzrcompute"

  // Permission flow — wired through to canUseTool inside the harness
  permissionMode: "auto",                       // "auto" | "ask" | "deny_destructive"
  onToolCall: async (call) => ({ decision: "allow" }),

  // Optional knobs forwarded to underlying SDK
  maxBudgetUsd: 5,
  maxTurns: 50,
  includePartials: true,
  sessionStore: new FileSessionStore("./sessions"),
});

// ── One-shot: await for the final result ──
const { result, usage, messages } = await agent.chat([
  { role: "user", content: "Build a TODO app" },
]);

// ── Streaming: iterate events as they arrive ──
const handle = agent.chat([
  { role: "user", content: "Build a TODO app" },
]);
for await (const ev of handle) {
  if (ev.kind === "sdk_message" && ev.message.type === "assistant") render(ev.message.message);
  if (ev.kind === "ca_permission_request") {
    await handle.respondToPermission(ev.callId, { decision: "allow" });
  }
  if (ev.kind === "ca_usage_snapshot") console.log(`$${ev.cost_usd} so far`);
}
const final = await handle.result();            // or just `await handle` — same thing

// ── Multi-turn: each .chat() is a turn over the same session ──
const r1 = await agent.chat([{ role: "user", content: "Build a TODO app" }]);
const r2 = await agent.chat([{ role: "user", content: "Now add tests" }]);

// ── Streaming input within one turn (advanced — mirrors claude-agent-sdk) ──
async function* userInput() {
  yield { role: "user", content: "Start working" };
  await waitForCondition();
  yield { role: "user", content: "Actually, also add docs" };
}
await agent.chat(userInput());

// ── Mid-flight controls ──
await handle.cancel();
```

### `.chat()` returns a `ChatHandle`

A `ChatHandle` is simultaneously:
- **`AsyncIterable<HarnessEvent>`** — `for await (const ev of handle)` streams events
- **`Promise<ChatResult>`** — `await handle` (or `await handle.result()`) resolves to the final `{ result, usage, messages }`
- Has methods: `.cancel()`, `.respondToPermission(callId, decision)`, `.sessionId` getter

This is the same dual-shape pattern as Anthropic's `client.messages.stream(...)`.

### Input shapes accepted by `.chat()`

```ts
agent.chat({ role: "user", content: "..." })           // single Message
agent.chat([msg1, msg2, ...])                          // array of Messages
agent.chat(asyncGenerator)                             // AsyncIterable<Message> — streaming input
agent.chat("just a string")                            // sugar for [{ role: "user", content: "..." }]
```

### Design decisions

- **Constructor = config; `.chat()` = invocation.** Configuration (who, how, where) is bound at agent construction; turns happen via `.chat()`. No `messages` field on the constructor.
- **One agent = one session.** Multiple `.chat()` calls on the same agent share its session. To start a fresh conversation, construct a new agent. (`agent.fork()` later if needed.)
- **Single verb.** `.chat()` replaces the old `.run()` / `.stream()` / `.send()` triplet. The same return value handles both one-shot (`await`) and streaming (`for await`).
- **Messages = Anthropic content-block shape** — same as Claude Agent SDK. Forward verbatim across the wire.
- **Stateless caller, optional pluggable session store.** We don't invent a session protocol — we expose the SDK's `SessionStore` interface verbatim through the `sessionStore` constructor option.
- **Permission enforcement is layered**: SDK config + GAP `compliance.supervision`. Strictest wins. If `agent.yaml` says `human_in_the_loop: always`, the caller cannot override to `auto`.
- **`includePartials: true`** turns on token-by-token deltas via `SDKPartialAssistantMessage`. The harness server flips on `includePartialMessages` upstream; clients see them in the SSE stream.

### Wire mapping

| SDK call | HTTP |
|---|---|
| `new ComputerAgent({...})` | No request — constructor only stores config |
| `agent.chat(msgs)` (first call) | `POST /v1/chat` (one-shot transport) — body carries config + messages, response is the SSE stream |
| `agent.chat(msgs)` (subsequent calls — same agent) | `POST /v1/sessions/:id/messages` + reuse open `/events` stream |
| `handle.cancel()` | `POST /v1/sessions/:id/cancel` |
| `handle.respondToPermission(callId, decision)` | `POST /v1/sessions/:id/permission/:callId` |

The first-call vs subsequent-call distinction is an SDK-internal optimization — users see one method.

## Substrate Protocol (refined)

```ts
interface Substrate {
  // Process lifecycle for the harness server itself
  bootHarness(opts: {
    image: string;             // "computeragent/harness-claudecode:latest"
    envs: Record<string, string>;
    workdir?: string;          // GAP repo will be mounted here
  }): Promise<{ id: string; baseUrl: string; ready: Promise<void> }>;

  // GAP repo materialization
  mountGapRepo(id: string, source: GapSource): Promise<{ path: string; sha: string }>;

  // Execution primitives (used BY the harness inside the runtime, not by the SDK)
  exec(opts: ExecOpts): AsyncIterable<ExecEvent>;

  fs: {
    read(path: string): Promise<Buffer>;
    write(path: string, data: Buffer | string): Promise<void>;
    mkdir(path: string, opts?: { recursive: boolean }): Promise<void>;
    rm(path: string, opts?: { recursive: boolean }): Promise<void>;
    list(path: string): Promise<string[]>;
  };

  network: {
    portForward(internalPort: number): Promise<{ url: string; close: () => Promise<void> }>;
  };

  shutdown(id: string): Promise<void>;
  health(id: string): Promise<"healthy" | "unhealthy" | "unknown">;
}
```

`runtime-local` implements with `child_process` + `fs/promises` (port-forward is a no-op — server binds to 127.0.0.1). `runtime-e2b` wraps `@e2b/sdk`'s `Sandbox` API and uses `sandbox.getHost(port)` for port forwarding.

## Build Order — Three Sequential Wedges

We don't build everything at once. Each wedge is independently demoable and useful.

### Wedge 1 — The Standard ("curl can drive an agent")

**Ships:** `@computeragent/protocol`, `@computeragent/harness-server`, `@computeragent/engine-claude-agent-sdk`, `@computeragent/identity-gitagentprotocol`

**No client SDK yet, no substrates yet.** Just the server framework + first engine + first loader.

#### Wedge 1 MVP — what's IN

The minimum that proves the standard works end-to-end with `curl`:

- `@computeragent/protocol`: REST + SSE zod schemas, `EngineDriver` + `IdentityLoader` interfaces, `IdentitySource` discriminated union, SDK passthrough re-exports
- `@computeragent/harness-server`:
  - `createHarnessServer({ engines, identityLoaders })` factory
  - Hono routes for `/v1/chat`, `/v1/sessions`, `/messages`, `/permission/:callId`, `/cancel`, `/events` (SSE), `/fs/*` (workspace filesystem), `/health`
  - In-memory `SessionRegistry` with TTL eviction
  - Per-session: workdir, user-message queue, abort controller, permission promise map
  - Path-jailed workspace FS service (Node `fs/promises` in MVP; same routes will plug into `substrate.fs` port in Wedge 3)
  - Capability negotiation (echo plug-in capabilities on `/health` + `ca_session_started`)
- `@computeragent/engine-claude-agent-sdk`: ~150 LOC wrapper around `query()`. `canUseTool` bridge. Forwards `SDKMessage` verbatim.
- `@computeragent/identity-gitagentprotocol` (minimal translation table only):
  - Source resolution: `git` (clone via `simple-git`), `local` (copy), `inline` (write to disk)
  - GAP → Claude Agent SDK options: `model`, `maxTurns`, stitched `systemPrompt` (SOUL.md + RULES.md + AGENTS.md), `cwd = workdir`, `skills/` symlinked to `.claude/skills/`
  - Wraps `@open-gitagent/gapman` for validation
- `@computeragent/testing`: `MockEngine` (deterministic), `MockLoader`, supertest helpers
- One end-to-end demo: `examples/wedge1-curl.sh` runs the full flow against GAP `examples/standard` and asserts a `result` SDK message arrives.

#### Wedge 1 — what's OUT (deferred to 1.5)

These are real, intended features but they don't belong on the *first* ship — they would slow down proof of the core architecture:

- `Last-Event-ID` replay buffer (clients must reconnect-from-scratch in MVP — fine for `curl` demo)
- `AuditSink` strategy + audit-log tee
- `AuthHandler` strategy + bearer/JWT
- Budget enforcement *at the framework level* (Claude SDK already enforces `maxBudgetUsd` internally; framework wrap-and-emit comes later)
- GAP → MCP translation (`tools/*.yaml` → `createSdkMcpServer`) — agents that use only built-in Claude tools (Read, Edit, Bash, …) work without it; GAP `examples/standard` does
- GAP `agents/` recursive sub-agent loading
- GAP `hooks/` translation
- GAP `compliance.supervision.human_in_the_loop` *enforcement* (passed through to caller for now; mandatory enforcement lands with audit)
- Full conformance suite (MVP ships ~6 conformance tests covering the happy path; full suite — ~30 tests, all error paths — lands in 1.5)
- `pino` structured logging (MVP can use a tiny `logger.ts` wrapper that no-ops in tests)

This is not corner-cutting. It's discipline: a smaller surface ships faster, gets feedback faster, and forces us to confront whether the core abstractions are right *before* we commit to features that depend on them.

#### Wedge 1 build sequence (the order we actually write code)

Each step ends with something runnable. Don't proceed to step N+1 until N green.

1. **Workspace skeleton.** pnpm workspace, turbo, tsconfig.base.json, `.gitignore`, README. `pnpm install` clean.
2. **`@computeragent/protocol`.** Zod schemas + interfaces only. No runtime logic. `pnpm --filter protocol build` and `test` green. ≤ 6 files.
3. **`@computeragent/testing`** (`MockEngine` + `MockLoader` only — no conformance suite yet). Trivial deterministic implementations. Used by harness-server tests next. ≤ 3 files.
4. **`@computeragent/harness-server` skeleton.** `createHarnessServer` factory + `/health` route only. Test: GET /health returns capabilities of registered MockEngine.
5. **Sessions + events.** Add `POST /v1/sessions`, `GET /v1/sessions/:id/events` (SSE). Extract `services/create-session.ts` and `services/run-session.ts` from the start so step 6 can reuse them. Test: create a session backed by MockEngine, open events, see `ca_session_started` + mock events flow.
6. **`POST /v1/chat`** (one-shot convenience). Reuses `create-session` + `run-session` services from step 5; the route handler is ~40 LOC. Test: single POST returns SSE stream, first event includes `sessionId`, MockEngine result reaches client, session is auto-deleted on stream end.
7. **Messages + cancel.** Add `POST /messages`, `POST /cancel`. Test: messages reach MockEngine's user-message queue; cancel ends the stream with `ca_session_ended`.
8. **Permissions.** Add `POST /permission/:callId`. Test: MockEngine emits permission-needed; SSE event arrives; POST decision; engine resumes. Verify works through both `/v1/chat` and the session API.
9. **Filesystem API.** Build `path-jail.ts` first (with hostile-input tests: `..`, `/etc`, symlink-out, null bytes), then `services/workspace-fs.ts`, then `routes/fs.ts`. Tests: tree of a fixture workdir; read/write round-trip; edit string-replace; delete; mkdir; move; every path-traversal vector rejected.
10. **`@computeragent/engine-claude-agent-sdk`.** Real engine. Mock `query()` in tests. ≤ 4 files.
11. **`@computeragent/identity-gitagentprotocol`.** Source resolver + minimal translator. Snapshot tests against checked-in fixture of GAP `examples/minimal` and `examples/standard`. ≤ 6 files.
12. **`examples/wedge1-server.ts`** + **`examples/wedge1-curl.sh`.** The curl demo uses `POST /v1/chat` for the one-liner. A second `examples/wedge1-session-curl.sh` demonstrates the session API. A third `examples/wedge1-fs-tour.sh` runs an agent and then `curl`s the FS endpoints to read what it produced. Both run against real Anthropic API gated by `ANTHROPIC_API_KEY`.

**Demo:**
```bash
# Terminal 1
$ pnpm exec harness-server          # boots on :7700
listening on http://127.0.0.1:7700

# Terminal 2
$ curl -X POST http://127.0.0.1:7700/v1/sessions \
    -H "Content-Type: application/json" \
    -d '{
      "engine": "claude-agent-sdk",
      "identity": {
        "loader": "gitagentprotocol",
        "source": { "type": "git", "url": "github.com/open-gitagent/gitagent-protocol/examples/standard" }
      },
      "envs": { "ANTHROPIC_API_KEY": "sk-..." },
      "options": { "maxTurns": 20 }
    }'
{"sessionId":"sess_01","engine":"claude-agent-sdk","gap":{"name":"code-reviewer",...},
 "eventsUrl":"/v1/sessions/sess_01/events"}

# Terminal 3 — open the SSE stream
$ curl -N http://127.0.0.1:7700/v1/sessions/sess_01/events
event: ca_session_started
id: 0
data: {"sessionId":"sess_01",...}

# Terminal 2 — push a user message
$ curl -X POST http://127.0.0.1:7700/v1/sessions/sess_01/messages \
    -d '{"message":{"role":"user","content":"Review the README for inconsistencies"}}'
{"ack":true}

# Terminal 3 receives:
event: sdk_message
id: 1
data: {"type":"system","subtype":"init",...}

event: sdk_message
id: 2
data: {"type":"assistant","message":{"content":[{"type":"text","text":"I'll review..."}],...},...}

event: sdk_message
id: 3
data: {"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"README.md"}}],...},...}
... (full agentic loop streams through) ...

event: sdk_message
id: N
data: {"type":"result","subtype":"success","result":"...","total_cost_usd":0.04,...}

event: ca_session_ended
data: {"reason":"complete"}
```

**Why this is the right first wedge:** the standard exists and is proveably useful with `curl`. Anyone — Python, Go, Rust, browser, Postman — can drive an agent over a stable HTTP+SSE contract. The client SDK is just sugar.

**Conformance suite ships with this wedge** so future engine and loader authors validate compliance from day one.

### Wedge 2 — The Client ("ergonomic TypeScript")

**Ships:** `@computeragent/sdk`, `@computeragent/cli`

**Adds:**
```ts
const agent = new ComputerAgent({
  source: "github.com/open-gitagent/gitagent-protocol/examples/standard",
  harness: "claude-agent-sdk",
  runtime: "local",                    // implicit: localhost:7700
  envs: { ANTHROPIC_API_KEY: "..." },
  messages: [{ role: "user", content: "Review the README for inconsistencies" }],
});

for await (const ev of agent.stream()) { /* … */ }
```

CLI:
```bash
computeragent run github.com/.../examples/standard --message "Review the README"
```

**Demo proves:** equivalent UX to wedge 1 but ergonomic, typed, and with `Last-Event-ID` resume on connection drops.

### Wedge 3 — The Substrates ("run anywhere")

**Ships:** `@computeragent/runtime-local`, `@computeragent/runtime-e2b`

**Adds:** the harness server can run *outside* the user's process — inside an E2B sandbox or subprocess pool. The Substrate Protocol is implemented per runtime.

**Demo:**
```bash
$ computeragent run <gap-repo> --runtime local --message "..."
$ computeragent run <gap-repo> --runtime e2b   --message "..."
```
Same streamed output. Substrate swap is a string change.

**This is where the 3-axis decomposition pays off in practice.**

### Out of scope until later

- `engine-gitclaw`, `engine-codex`, `engine-opencode`, `engine-gemini-cli` — ecosystem builds these
- `runtime-lyzrcompute`, `runtime-openshell` — wedge 4
- `identity-openai-assistants`, `identity-crewai` — ecosystem
- Multi-tenant server mode, A2A, audit-log persistence, billing — post-v1.0

## Roadmap

| Phase | Adds | Why |
|---|---|---|
| **v0.1** (Wedge 1 MVP) | protocol + harness-server (core) + engine-claude-agent-sdk + identity-gitagentprotocol (minimal translation) + MockEngine/MockLoader | The standard exists; curl drives an agent end-to-end |
| **v0.1.5** (Wedge 1.5) | `Last-Event-ID` replay buffer, `AuditSink`, `AuthHandler`, full conformance suite, GAP→MCP tool translation, `pino` logging, GAP sub-agents + hooks | Production-ready standard; conformance gates third-party plug-ins |
| **v0.2** (Wedge 2) | sdk (client) + cli | Ergonomic TS surface on top of the standard |
| **v0.3** (Wedge 3) | runtime-local + runtime-e2b | 3-axis decomposition demonstrated; same call shape, swappable substrate |
| **v0.4** | engine-gitclaw, full HITL UX (CLI prompt + webhook), `FileSessionStore` | Validate engine pluggability with your 2nd harness; unblock regulated agents |
| **v0.5** | runtime-lyzrcompute, `ca_usage_snapshot` cost telemetry, GAP `compliance.recordkeeping` enforcement | Lyzr-native deployment; compliance teeth |
| **v0.6** | runtime-openshell (OSS reference substrate), Python client SDK (sibling, shared protocol) | Open-source the runtime; second-language client |
| **v0.7** | `computeragent serve` (multi-tenant gateway), session attach/detach, A2A adapter | Production deployments, agent-to-agent calls |
| **v1.0** | Stable Harness Protocol + Substrate Protocol RFC, third-party engine/identity/runtime ecosystem, `computeragent` registry | The OCI moment |

## Critical Reused Building Blocks

- **`@anthropic-ai/claude-agent-sdk`** — entire `claudecode` harness is built on `query()`, `tool()`, `createSdkMcpServer()`. Don't reinvent.
- **`@open-gitagent/gapman`** — validation, GAP loading, dependency resolution. Wrap as library.
- **`@e2b/sdk`** — substrate primitives for E2B. Don't reinvent sandboxing.
- **`hono` + `hono/streaming`** — small, fast HTTP + SSE for harness servers; runs on Node, Bun, Deno, Cloudflare.
- **`zod`** — runtime-validated protocol messages; emits JSON Schema for `@computeragent/protocol`.
- **`undici` `EventSource`** (or `eventsource` polyfill) — SSE client in `@computeragent/sdk` with `Last-Event-ID`.

## File / Module Skeleton (Wedge 1 MVP — what we build first)

Each file ≤ 250 LOC. If a file approaches the cap during build, split before merging.

```
/Users/zeus/ComputerAgent/
├── package.json                          # pnpm workspace root
├── pnpm-workspace.yaml
├── turbo.json
├── tsconfig.base.json
├── PLAN.md                               # this plan, copied
├── README.md
├── packages/
│   ├── protocol/                         # types + zod schemas only; no runtime logic
│   │   ├── src/harness-rest.ts           # zod schemas for REST request/response bodies
│   │   ├── src/sse-events.ts             # SSE event union (sdk_message + ca_*)
│   │   ├── src/contracts.ts              # EngineDriver, IdentityLoader interfaces
│   │   ├── src/identity-source.ts        # IdentitySource discriminated union
│   │   ├── src/sdk-passthrough.ts        # re-export SDKMessage from claude-agent-sdk
│   │   └── src/index.ts                  # public surface only
│   ├── harness-server/
│   │   ├── src/app.ts                    # createHarnessServer factory
│   │   ├── src/routes/chat.ts            # POST /v1/chat (one-shot; SSE response)
│   │   ├── src/routes/sessions.ts        # POST + DELETE /v1/sessions
│   │   ├── src/routes/messages.ts        # POST /v1/sessions/:id/messages
│   │   ├── src/routes/permission.ts      # POST /v1/sessions/:id/permission/:callId
│   │   ├── src/routes/cancel.ts          # POST /v1/sessions/:id/cancel
│   │   ├── src/routes/events.ts          # GET /v1/sessions/:id/events (SSE)
│   │   ├── src/routes/fs.ts              # FS routes (tree, file GET/PUT, edit, delete, mkdir, move)
│   │   ├── src/routes/health.ts          # GET /v1/health
│   │   ├── src/services/create-session.ts # shared by /chat and /sessions — single source of truth
│   │   ├── src/services/run-session.ts   # drives the engine; owned by /chat (auto) and /sessions (on-demand)
│   │   ├── src/services/workspace-fs.ts  # jailed FS ops (Wedge 1: Node fs; Wedge 3: substrate.fs port)
│   │   ├── src/path-jail.ts              # path validation: rejects ..; absolute; outside-workdir symlinks
│   │   ├── src/session.ts                # Session class — queue, abort, permission map
│   │   ├── src/registry.ts               # SessionRegistry — in-memory map + TTL
│   │   ├── src/sse-encoder.ts            # pure SSE serialization (Wedge 1.5: + replay)
│   │   ├── src/error-mapper.ts           # one middleware that maps throws → HTTP responses
│   │   └── src/index.ts
│   ├── engine-claude-agent-sdk/
│   │   ├── src/engine.ts                 # ClaudeAgentEngine implements EngineDriver
│   │   ├── src/permission-bridge.ts      # canUseTool ↔ ctx.onPermissionRequest
│   │   └── src/index.ts
│   ├── identity-gitagentprotocol/
│   │   ├── src/loader.ts                 # GitAgentProtocolLoader implements IdentityLoader
│   │   ├── src/source-resolver.ts        # git | local | inline → workdir
│   │   ├── src/adapters/claude-agent-sdk.ts   # gapToClaudeAgentOptions (pure)
│   │   ├── src/skills.ts                 # skills/ → .claude/skills/ symlink (pure-ish)
│   │   └── src/index.ts
│   └── testing/
│       ├── src/mock-engine.ts            # deterministic EngineDriver
│       ├── src/mock-loader.ts            # deterministic IdentityLoader
│       ├── src/supertest-helpers.ts      # SSE-aware request helpers
│       └── src/index.ts
├── examples/
│   ├── wedge1-server.ts                  # boot script: registers real engine + loader
│   └── wedge1-curl.sh                    # the curl demo from the plan
└── docs/
    └── protocol.md                       # human-readable protocol spec (full doc + author guides land in 1.5)
```

**Deferred to Wedge 1.5:** `replay-buffer.ts`, `audit.ts`, `auth.ts` in harness-server; `tools.ts` (GAP→MCP) in identity-gitagentprotocol; full conformance suite in testing; engine/identity author guides.

**Deferred to Wedge 2/3:** Tier 3 packages (sdk + cli + runtime-local + runtime-e2b).

## Verification Plan

### Wedge 1 (the standard)

**Unit:**
- `protocol` — zod round-trip on every REST body and SSE event; type-narrowing tests on the event union
- `harness-server` — supertest-driven end-to-end against a `MockEngine` + `MockLoader` from `@computeragent/testing`:
  - POST `/v1/sessions` → 201 with sessionId
  - POST `/v1/sessions/:id/messages` while SSE stream open → message appears in event stream
  - GET `/v1/sessions/:id/events` with `Last-Event-ID: 5` → resumes from event 6
  - POST `/v1/sessions/:id/cancel` → SSE stream closes with `ca_session_ended { reason: "cancelled" }`
  - Permission flow: mock engine emits permission request → `ca_permission_request` SSE event → POST `/permission/:callId` → engine resumes
  - Replay buffer eviction past TTL
- `engine-claude-agent-sdk` — mock the SDK's `query()` (substitute an iterable that yields known SDKMessages); verify SDKMessage → EngineEvent forwarding and permission round-trip
- `identity-gitagentprotocol` — fixture tests against GAP `examples/minimal`, `standard`, `full`. Snapshot the resulting `ClaudeAgentOptions`. Verify skills/tools/agents/compliance translation.

**Integration:**
1. `pnpm exec harness-server` boots locally with `engine-claude-agent-sdk` + `identity-gitagentprotocol` registered
2. `examples/wedge1-curl.sh` runs the full curl flow against GAP `examples/standard`, asserts a `result` event arrives with non-empty `result` text
3. CI runs against real Anthropic API gated by `ANTHROPIC_API_KEY`

**Conformance suite (the publishable artifact):**
- `@computeragent/testing` ships a black-box suite that drives an arbitrary harness server through the protocol — every endpoint, edge case, error path
- Wedge-1 ships pass-on-day-one against this suite
- Future engine/loader contributors run the same suite locally before opening a PR
- The suite + protocol spec doc is what makes this a *standard* and not just our codebase

### Wedge 2 (the client)

**Unit:**
- `sdk` — mock SSE server; assert `agent.stream()` decodes the union correctly; assert dropped-connection + `Last-Event-ID` resume actually replays missed events

**Integration:**
- `pnpm dev` boots harness-server + uses `@computeragent/sdk` against it
- TS demo script produces identical outcome to the curl demo from Wedge 1

### Wedge 3 (the substrates)

**Unit:**
- `runtime-local` — exec/fs fixture tests; subprocess lifecycle on SIGINT
- `runtime-e2b` — mock E2B client; live integration test gated by `E2B_API_KEY`

**Integration:**
1. `examples/wedge3-local.ts` and `examples/wedge3-e2b.ts` run the same GAP repo through both substrates
2. Output messages structurally identical (modulo timing and uuids)
3. CI matrix `{ runtime: local, e2b } × { engine: claude-agent-sdk }` — same expected `result` content

## Risks / Open Questions (defer until after wedge)

1. **`SettingSources` interaction.** Claude Code reads `CLAUDE.md`, `.claude/`, user/global settings. We must pin `settingSources: ["project"]` inside the substrate to avoid leaking the host machine's Claude config. Verify this works in E2B's container.
2. **Skills discovery path collisions.** GAP's `skills/<name>/SKILL.md` and Claude Code's `.claude/skills/<name>/SKILL.md` use the same Agent Skills standard, so a symlink is sufficient. Verify the SDK respects them.
3. **MCP server lifetime.** GAP `tools/` → in-process MCP via `createSdkMcpServer`. They live for the duration of `query()`. If the user calls `agent.send()` for a 2nd turn, we keep the same server. Confirmed by streaming-input mode.
4. **`canUseTool` + `permissionMode`.** When mode is `bypassPermissions`, `canUseTool` is *not* invoked. We must enforce GAP compliance at the harness level — if `human_in_the_loop: always`, override caller's mode to `default` regardless of what they passed.
5. **GAP repo caching.** Content-addressed cache keyed by commit SHA. Live next to `.gitagent/` runtime state.
6. **Secret injection.** Short-lived envs vs. mounted secret files vs. metadata service per substrate. v0 uses envs; v0.3 adds optional secret-mount when `gap.compliance.data_governance.pii_handling: redact|encrypt`.
7. **Long-running session reattach.** Does `sessionId` map to a live container, or always rehydrate from event log + SDK `resume`? v0: rehydrate via SDK `resume`. v0.5: live attach to running containers.
8. **Cost telemetry standard.** SDK gives token counts and `total_cost_usd`. Substrate compute-seconds need a unified `ca_usage_snapshot.compute_seconds_substrate`.
9. **Tool-call permission UX in CLI mode.** TTY prompt vs. webhook vs. fail-closed. v0.2 ships TTY; webhook later.
10. **Multi-harness session portability.** Out of scope for v1.0. Sessions are bound to a harness because the SDK's session format is harness-specific.
