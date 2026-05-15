---
"@computeragent/protocol": minor
"@computeragent/harness-server": minor
"@computeragent/engine-claude-agent-sdk": minor
"@computeragent/engine-gitagent": minor
"@computeragent/identity-gitagentprotocol": minor
"@computeragent/runtime-local": minor
"@computeragent/runtime-e2b": minor
"@computeragent/runtime-vzvm": minor
"@computeragent/session-store-mongo": minor
"@computeragent/session-store-sqlite": minor
"@computeragent/sdk": minor
"@computeragent/cli": minor
"@computeragent/testing": minor
---

Initial v0.1 release surface.

Three pluggable ports — `EngineDriver`, `IdentityLoader`, `Substrate` — plus
the swappable-memory port `SessionStore` (Wedge 1.6). Reference
implementations:

- engines: `claude-agent-sdk`, `gitagent` (gitclaw)
- identity loader: `gitagentprotocol` (full GAP support — compliance,
  tools/MCP, sub-agents, hooks)
- substrates: `local` (subprocess), `e2b` (cloud), `vzvm` (Apple VZ via Tart)
- session stores: `memory`, `file`, `mongo`, `sqlite`
- harness-server: SSE+POST framework, replay buffer with Last-Event-ID
  resume, AuditSink + AuthHandler ports, opt-in load-result validation
- sdk: `ComputerAgent` + `runTask` one-shot helper + `await using` /
  Symbol.asyncDispose
- cli: `computeragent run …`
- testing: `MockEngine`, `MockLoader`, conformance suite

275 tests, all green. Live demos verified across all engines × all
substrates × all stores against the real Anthropic API.
