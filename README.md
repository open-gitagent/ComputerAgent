# ComputerAgent

> Run any GAP agent, anywhere, with any loop.

A reference implementation of the **Harness Protocol** — a framework-agnostic standard for executing AI agents over HTTP+SSE, with a complete agent workspace exposed through the same surface.

ComputerAgent decomposes the agent stack into three orthogonal axes:

- **WHAT** — agent identity, in any portable format (default: [GitAgentProtocol](https://github.com/open-gitagent/gitagent-protocol))
- **HOW** — the agentic loop, as a swappable engine (default: `@anthropic-ai/claude-agent-sdk`)
- **WHERE** — the substrate, as a swappable runtime (default: local subprocess; planned: E2B, Lyzr Compute)

## Status

Wedge 1 — the standard — under active development. See [`PLAN.md`](./PLAN.md) for the full architecture.

## Wedge 1 packages

| Package | Role |
|---|---|
| `@computeragent/protocol` | Type defs, zod schemas, `EngineDriver` / `IdentityLoader` contracts |
| `@computeragent/harness-server` | The reusable HTTP+SSE framework with workspace FS API |
| `@computeragent/engine-claude-agent-sdk` | First engine plug-in |
| `@computeragent/identity-gitagentprotocol` | First identity loader plug-in |
| `@computeragent/testing` | Mocks + supertest helpers |

## Quick start

Requires [Bun](https://bun.sh) ≥ 1.1 and [pnpm](https://pnpm.io) ≥ 9.

```bash
pnpm install
pnpm build
ANTHROPIC_API_KEY=sk-... bun run examples/wedge1-server.ts
# in another terminal:
bash examples/wedge1-curl.sh
```

The harness server runs natively on Bun (Hono is Bun-optimized) but the published packages also work on Node ≥ 20.

## License

MIT
