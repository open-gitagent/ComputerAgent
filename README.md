# ComputerAgent

> Run any GAP agent, anywhere, with any loop.

A reference implementation of the **Harness Protocol** — a framework-agnostic standard for executing AI agents over HTTP+SSE, with a complete agent workspace exposed through the same surface.

ComputerAgent decomposes the agent stack into three orthogonal axes — any combination of the three works through the same SDK call:

- **WHAT** — agent identity, in any portable format. Default: [GitAgentProtocol](https://github.com/open-gitagent/gitagent-protocol) repos. Add your own with an `IdentityLoader` plug-in.
- **HOW** — the agentic loop. Ships with two engines today: `@anthropic-ai/claude-agent-sdk` and `gitclaw` (gitagent). Add your own with an `EngineDriver` plug-in.
- **WHERE** — the substrate. Ships with three: local subprocess, [E2B](https://e2b.dev) cloud sandbox, and [VZVirtualMachine via Tart](https://tart.run/). Add your own with a `Substrate` implementation.

## Status

| Wedge | What it ships | Status |
|---|---|---|
| 1 — The Standard | Harness Protocol + `harness-server` framework + GAP loader + 2 engines | ✅ |
| 2 — Client SDK | `@computeragent/sdk` — typed TS client | ✅ |
| 2.1 — CLI | `computeragent run …` | ✅ |
| 3 — Substrates | `runtime-local`, `runtime-e2b`, `runtime-vzvm` | ✅ |
| 1.5 — Hardening | replay buffer, audit log, auth, conformance suite | future |

102 tests across 11 packages, all green. End-to-end live demos against real Anthropic + E2B APIs verified.

See [`PLAN.md`](./PLAN.md) for the full architecture history.

## Quick start

Requires [Bun](https://bun.sh) ≥ 1.1 and [pnpm](https://pnpm.io) ≥ 9.

```bash
pnpm install
pnpm build
```

### Run an agent in a local subprocess

```ts
import { ComputerAgent } from "@computeragent/sdk";
import { LocalSubstrate } from "@computeragent/runtime-local";

const agent = new ComputerAgent({
  source: { type: "git", url: "github.com/open-gitagent/gitagent-protocol", subdir: "examples/standard" },
  harness: "claude-agent-sdk",
  envs: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY! },
  runtime: new LocalSubstrate(),
});

for await (const ev of agent.chat("Review the README for inconsistencies")) {
  // SDKMessage events stream as they arrive
}
await agent.dispose();
```

### Run it in an E2B cloud sandbox — same code, different `runtime`

```ts
import { E2BSubstrate } from "@computeragent/runtime-e2b";
// ...everything else the same...
runtime: new E2BSubstrate({ apiKey: process.env.E2B_API_KEY! }),
```

### Or in a VZVirtualMachine via Tart (Apple Silicon)

```ts
import { VZVMSubstrate } from "@computeragent/runtime-vzvm";
// brew install cirruslabs/cli/tart && tart pull ghcr.io/cirruslabs/ubuntu:latest
runtime: new VZVMSubstrate({
  baseImage: "ghcr.io/cirruslabs/ubuntu:latest",
  sshUser: "admin",
  sshPassword: "admin",
}),
```

## CLI

```bash
computeragent health
computeragent run github.com/org/my-agent -m "your message" --permission-mode bypassPermissions
```

## Curl works too

The standard is a plain HTTP+SSE protocol. Anything that speaks HTTP can drive it:

```bash
bun run examples/wedge1-server.ts &
bash examples/wedge1-curl.sh
bash examples/wedge1-fs-tour.sh    # agent writes a file; curl /fs/* to inspect
```

## Packages

| Package | Role |
|---|---|
| `@computeragent/protocol` | Type defs + zod schemas + EngineDriver/IdentityLoader contracts |
| `@computeragent/harness-server` | Generic HTTP+SSE framework with workspace FS API |
| `@computeragent/engine-claude-agent-sdk` | Wraps `@anthropic-ai/claude-agent-sdk` |
| `@computeragent/engine-gitagent` | Wraps `gitclaw` ([open-gitagent/gitagent](https://github.com/open-gitagent/gitagent)) |
| `@computeragent/identity-gitagentprotocol` | Loads GitAgentProtocol repos |
| `@computeragent/runtime-local` | Subprocess pool on the host |
| `@computeragent/runtime-e2b` | Cloud sandbox via [E2B](https://e2b.dev) |
| `@computeragent/runtime-vzvm` | Linux VM on Apple Silicon via [Tart](https://tart.run/) |
| `@computeragent/sdk` | The user-facing client |
| `@computeragent/cli` | `computeragent` binary |
| `@computeragent/testing` | Mocks + SSE helpers |

## Architecture in three minutes

```
User code
    │
    │  new ComputerAgent({ source, harness, runtime, envs }).chat(msgs)
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
└─────────────────────────────────────────────┘
    │                              │
    │  EngineDriver port           │  IdentityLoader port
    ▼                              ▼
┌──────────────────────┐   ┌──────────────────────────┐
│ engine-claude-…       │   │ identity-gitagentprotocol │
│ engine-gitagent       │   │ (your-loader here)        │
│ (your-engine here)    │   └──────────────────────────┘
└──────────────────────┘
    │
    │ Substrate port: bootHarness({envs}) → {baseUrl, shutdown}
    ▼
┌──────────────────────────────────────────────────────┐
│ runtime-local   runtime-e2b   runtime-vzvm           │
│ (subprocess)    (cloud)        (Apple VZ)            │
│ (your-substrate here)                                │
└──────────────────────────────────────────────────────┘
```

The protocol is the artifact. Engines, identity loaders, and substrates are plug-ins.

## License

[MIT](./LICENSE)
