# ComputerAgent

[![CI](https://github.com/open-gitagent/ComputerAgent/actions/workflows/ci.yml/badge.svg)](https://github.com/open-gitagent/ComputerAgent/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Tests](https://img.shields.io/badge/tests-278%20passing-brightgreen)](#status)
[![Packages](https://img.shields.io/badge/packages-13-blue)](#packages)
[![Discussions](https://img.shields.io/github/discussions/open-gitagent/ComputerAgent?logo=github&label=Discussions)](https://github.com/open-gitagent/ComputerAgent/discussions)
[![GitHub stars](https://img.shields.io/github/stars/open-gitagent/ComputerAgent?style=social)](https://github.com/open-gitagent/ComputerAgent/stargazers)

> **Run any AI agent, anywhere, with any loop, and any memory backend.**
>
> Think Docker for AI agents — a portable agent definition (any format), a swappable engine, a swappable host, a swappable memory store. One SDK call, four orthogonal axes.

```bash
npx create-computeragent my-agent
cd my-agent && npm install
ANTHROPIC_API_KEY=sk-ant-... npm start
```

That's it. 60 seconds to a running agent.

A reference implementation of the **Harness Protocol** — a framework-agnostic standard for executing AI agents over HTTP+SSE, with a complete agent workspace exposed through the same surface.

## Why ComputerAgent

- **Portable agents** — agents are git repos (or inline manifests), not framework-specific Python objects. Move them between machines, between teams, between models without rewriting.
- **Swappable everything** — the four ports (engine / identity / substrate / memory) are independently pluggable. Run the same agent on your laptop today and in an E2B sandbox tomorrow with a one-line change.
- **Boring tech** — Hono on Bun/Node, Zod, vitest, MIT. No experimental frameworks. The protocol is plain HTTP+SSE; `curl` can drive it.
- **Production-shaped failure semantics** — explicit, documented contracts: `AuditSink` is fire-and-forget, `SessionStore` is fail-loud, sibling sessions never share blast radius. Validated by an adversarial conformance suite.
- **Live-tested** — every substrate × every engine × every memory backend verified end-to-end against the real Anthropic API.

### vs. other agent frameworks

| | LangChain / LangGraph | CrewAI | AutoGen | OpenInterpreter | **ComputerAgent** |
|---|---|---|---|---|---|
| Agent definition is portable across processes | Python class | Python YAML | Python class | Python | **Git repo / inline manifest (any language)** |
| Wire protocol you can drive with `curl` | ❌ | ❌ | ❌ | ❌ | **✅ HTTP+SSE** |
| Same code runs locally + in cloud sandbox + in a VM | Per-integration | Per-integration | Per-integration | Local only | **✅ One-line `runtime:` swap** |
| Swappable conversation memory backend | Per-integration | ❌ | Per-integration | ❌ | **✅ One-line `sessionStore:` swap** |
| Resume across process restart, host changes, substrate teardown | Manual | ❌ | Manual | ❌ | **✅ Built-in (`SessionStore`)** |
| Conformance suite for third-party plug-ins | ❌ | ❌ | ❌ | ❌ | **✅ `@computeragent/testing`** |

ComputerAgent decomposes the agent stack into **four orthogonal axes** — any combination works through the same SDK call:

- **WHAT** — agent identity. Default loader: [GitAgentProtocol](https://github.com/open-gitagent/gitagent-protocol). Add your own with an `IdentityLoader`.
- **HOW** — the agentic loop. Two engines today: `@anthropic-ai/claude-agent-sdk` and `gitclaw` (gitagent). Add your own with an `EngineDriver`.
- **WHERE** — the substrate. Three today: local subprocess, [E2B](https://e2b.dev) cloud sandbox, and [VZVirtualMachine via Tart](https://tart.run/). Add your own with a `Substrate`.
- **REMEMBER** — session storage. Three today: in-memory, file (JSONL), MongoDB. Add your own with a `SessionStore`.

275 tests across 13 packages, all green. End-to-end live demos verified against the real Anthropic API across all three substrates AND all three session stores, for both engines.

## 60-second getting started

Two ways. Either scaffolds a runnable project; pick one.

**Fastest — `npx create-computeragent`:**

```bash
npx create-computeragent my-agent
cd my-agent && npm install
ANTHROPIC_API_KEY=sk-ant-... npm start
```

**Or wire it up yourself:**

```bash
npm install computeragent
```

```ts
// my-first-agent.ts
import { runTask, LocalSubstrate } from "computeragent";

const result = await runTask({
  source: {
    type: "inline",
    manifest: { name: "hello", version: "0.1.0" },
    files: {
      "agent.yaml": [
        'spec_version: "0.1.0"',
        "name: hello",
        "version: 0.1.0",
        "model: { preferred: claude-haiku-4-5-20251001 }",
        "runtime: { max_turns: 2 }",
      ].join("\n"),
      "SOUL.md": "Respond in one short sentence.",
    },
  },
  harness: "claude-agent-sdk",
  envs: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY! },
  runtime: new LocalSubstrate(),
  message: "Say hi.",
});

console.log(result.ended.reason);   // "complete"
```

```bash
ANTHROPIC_API_KEY=sk-... node --experimental-strip-types my-first-agent.ts
```

That's it. No harness server to boot, no session lifecycle to manage — `runTask` handles everything and tears the substrate down before returning.

The `computeragent` umbrella package gives you the SDK + `LocalSubstrate` in one install. For other substrates / engines / memory backends, install the scoped packages alongside (see [Packages](#packages)).

## Swap the substrate. Same code.

```ts
import { E2BSubstrate }   from "@computeragent/runtime-e2b";
import { VZVMSubstrate }  from "@computeragent/runtime-vzvm";
import { LocalSubstrate } from "@computeragent/runtime-local";

runtime: new LocalSubstrate(),                                          // host process
runtime: new E2BSubstrate({ apiKey: process.env.E2B_API_KEY! }),        // cloud sandbox
runtime: new VZVMSubstrate({                                            // Apple Silicon VM
  baseImage: "ghcr.io/cirruslabs/ubuntu:latest",
  sshUser: "admin", sshPassword: "admin",
}),
```

## Swap the memory. Same agent, different backend.

```ts
// In-process memory (default — no setup):
sessionStore: { kind: "memory" }

// JSONL on disk:
sessionStore: { kind: "file", options: { root: "./sessions" } }

// MongoDB — survives across processes / hosts:
sessionStore: { kind: "mongo" }
//   ^ resolved server-side via createHarnessServer({
//       sessionStores: { mongo: mongoSessionStoreBuilder({ url: process.env.MONGO_URL! }) }
//     })
```

Pass `sessionId: "<previous>"` to a fresh `runTask` and the agent picks up the conversation from the store — proven for all three engines × backends. See [`examples/wedge16-mongo-resume-demo.ts`](./examples/wedge16-mongo-resume-demo.ts) and [`examples/wedge16-gitagent-mongo-demo.ts`](./examples/wedge16-gitagent-mongo-demo.ts).

## Swap the engine. Same SDK call.

```ts
harness: "claude-agent-sdk",  // wraps @anthropic-ai/claude-agent-sdk
harness: "gitagent",          // wraps gitclaw (open-gitagent/gitagent)
```

## Curl works too

The protocol is plain HTTP+SSE. Anything that speaks HTTP can drive it:

```bash
bun run examples/wedge1-server.ts &
bash examples/wedge1-curl.sh
bash examples/wedge1-fs-tour.sh    # agent writes a file; curl /fs/* to inspect
```

## CLI

```bash
computeragent health
computeragent run github.com/org/my-agent -m "your message"
```

## Status

| Wedge | What it ships | Status |
|---|---|---|
| 1 — The Standard | Harness Protocol + `harness-server` framework + GAP loader + 2 engines | ✅ |
| 1.5 — Hardening | Last-Event-ID replay buffer, `AuditSink`, `AuthHandler`, conformance suite, GAP compliance/tools/sub-agents/hooks | ✅ |
| 1.6 — Swappable session memory | `SessionStore` port + Memory/File/Mongo/SQLite backends + per-engine replay | ✅ |
| 2 — Client SDK | `@computeragent/sdk` — typed TS client + `runTask` one-shot helper + `await using` | ✅ |
| 2.1 — CLI | `computeragent run …` | ✅ |
| 3 — Substrates | `runtime-local`, `runtime-e2b`, `runtime-vzvm` | ✅ |

See [`PLAN.md`](./PLAN.md) for the full architecture history.

## Packages

| Package | Role |
|---|---|
| **`computeragent`** | Umbrella — re-exports SDK + `LocalSubstrate`. The one-line install. |
| `create-computeragent` | `npx create-computeragent my-agent` scaffolder |
| `@computeragent/protocol` | Type defs + zod schemas + `EngineDriver` / `IdentityLoader` / `SessionStore` contracts |
| `@computeragent/harness-server` | Generic HTTP+SSE framework with workspace FS API + built-in stores (Memory, File) |
| `@computeragent/engine-claude-agent-sdk` | Wraps `@anthropic-ai/claude-agent-sdk` |
| `@computeragent/engine-gitagent` | Wraps `gitclaw` ([open-gitagent/gitagent](https://github.com/open-gitagent/gitagent)) — synthesizes resume via `session-replay` |
| `@computeragent/identity-gitagentprotocol` | Loads GitAgentProtocol repos |
| `@computeragent/runtime-local` | Subprocess pool on the host |
| `@computeragent/runtime-e2b` | Cloud sandbox via [E2B](https://e2b.dev) |
| `@computeragent/runtime-vzvm` | Linux VM on Apple Silicon via [Tart](https://tart.run/) |
| `@computeragent/session-store-mongo` | MongoDB-backed `SessionStore` |
| `@computeragent/session-store-sqlite` | SQLite-backed `SessionStore` |
| `@computeragent/sdk` | The user-facing client (`ComputerAgent`, `ChatHandle`, `runTask`) |
| `@computeragent/cli` | `computeragent` binary |
| `@computeragent/testing` | Mocks + SSE helpers + the conformance suite (`conformanceCases`, `runConformanceSuite`) |

## Architecture in three minutes

```
User code
    │
    │  new ComputerAgent({ source, harness, runtime, sessionStore, envs }).chat(msgs)
    ▼
┌─────────────────────────────────────────────┐
│  @computeragent/sdk                         │
│  (HTTP+SSE client, ChatHandle, permissions) │
└─────────────────────────────────────────────┘
    │
    │  Harness Protocol (SSE + POST over HTTP)
    │  /v1/sessions, /chat, /events, /messages, /permission, /cancel, /fs/*
    ▼
┌─────────────────────────────────────────────┐
│  @computeragent/harness-server              │
│  - Routes (Hono on Bun or Node)             │
│  - Session lifecycle + permission map       │
│  - Path-jailed workspace FS over HTTP       │
│  - Pluggable AuditSink + AuthHandler        │
│  - SessionStore registry (memory/file/...)  │
└─────────────────────────────────────────────┘
    │                  │                   │
    │ EngineDriver     │ IdentityLoader    │ SessionStore
    ▼                  ▼                   ▼
┌──────────────────┐ ┌────────────────────────┐ ┌──────────────────────┐
│ engine-claude-…  │ │ identity-gitagent…     │ │ MemorySessionStore   │
│ engine-gitagent  │ │ (your-loader here)     │ │ FileSessionStore     │
│ (your-engine)    │ └────────────────────────┘ │ MongoSessionStore    │
└──────────────────┘                            │ SqliteSessionStore   │
    │                                           │ (your-store here)    │
    │ Substrate: bootHarness({envs}) → {url}    └──────────────────────┘
    ▼
┌──────────────────────────────────────────────────────┐
│ runtime-local   runtime-e2b   runtime-vzvm           │
│ (subprocess)    (cloud)        (Apple VZ)            │
│ (your-substrate here)                                │
└──────────────────────────────────────────────────────┘
```

The protocol is the artifact. Engines, identity loaders, substrates, and session stores are plug-ins.

## Adding your own plug-in

Every port follows the same shape: implement a small interface, register at `createHarnessServer({...})` boot. No fork required.

```ts
import { createHarnessServer } from "@computeragent/harness-server";
import { mongoSessionStoreBuilder } from "@computeragent/session-store-mongo";

createHarnessServer({
  engines: {
    "claude-agent-sdk": new ClaudeAgentEngine(),
    "your-engine":      new YourEngine(),     // implements EngineDriver
  },
  identityLoaders: {
    gitagentprotocol: new GitAgentProtocolLoader(),
    "your-format":    new YourLoader(),       // implements IdentityLoader
  },
  sessionStores: {
    mongo: mongoSessionStoreBuilder({ url: process.env.MONGO_URL! }),
    redis: (cfg) => new YourRedisStore(cfg),  // implements SessionStore
  },
  authHandler: bearerToken(verifyJwt),         // implements AuthHandler
  auditSink:   new YourS3AuditSink(),          // implements AuditSink
});
```

Then drive it with `curl`, the SDK, the CLI — same protocol, same wire shape.

## Conformance

Third-party `EngineDriver` / `IdentityLoader` / `SessionStore` implementations validate against the same suite the reference implementation runs against:

```ts
import { conformanceCases, runConformanceSuite } from "@computeragent/testing";

const report = await runConformanceSuite(() => yourDriverFor(yourHarness));
console.log(`${report.passed} passed, ${report.failed.length} failed`);
```

If your implementation passes the suite, it's a drop-in replacement.

## Community

Questions, ideas, build journals — head to **[Discussions](https://github.com/open-gitagent/ComputerAgent/discussions)**. Issues are for actionable bugs and feature requests.

If ComputerAgent helps you build something, **⭐ star the repo** — it makes a real difference for discoverability. While you're there, the open protocol this implements lives at **[open-gitagent/opengap](https://github.com/open-gitagent/opengap)** — give that a star too.

### Star history

[![Star History Chart](https://api.star-history.com/svg?repos=open-gitagent/ComputerAgent&type=Date)](https://star-history.com/#open-gitagent/ComputerAgent&Date)

## License

[MIT](./LICENSE)
