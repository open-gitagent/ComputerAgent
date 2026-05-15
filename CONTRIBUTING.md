# Contributing to ComputerAgent

ComputerAgent is a TypeScript monorepo (pnpm + turbo) implementing the **Harness Protocol** as a set of pluggable ports. Most contributions add a new plug-in (engine, identity loader, substrate, session store) by implementing a small interface — the framework itself is intentionally closed to modification.

## Setup

Requires [Bun](https://bun.sh) ≥ 1.1, [Node](https://nodejs.org) ≥ 20, [pnpm](https://pnpm.io) ≥ 9.

```bash
git clone https://github.com/open-gitagent/ComputerAgent
cd ComputerAgent
pnpm install
pnpm build
pnpm test
```

CI runs `pnpm -r build`, `pnpm -r typecheck`, and `pnpm -r test` on Node 20 and 22 for every PR.

## Adding a plug-in

The four pluggable ports each follow the same shape — implement the interface, register at server boot.

| Port | Where it lives | Contract |
|---|---|---|
| `EngineDriver` | `packages/engine-*` | Wraps an agent loop. `startSession(ctx)` returns an `AsyncIterable<EngineEvent>`. |
| `IdentityLoader` | `packages/identity-*` | Translates a "what is this agent" source into engine-native options. `load(args)` returns `IdentityLoadResult`. |
| `Substrate` | `packages/runtime-*` | Boots a harness-server somewhere. `bootHarness({envs})` returns `{baseUrl, shutdown}`. |
| `SessionStore` | `packages/session-store-*` | Cross-process conversation persistence. `append(key, entries)` + `load(key)`. Re-exported from the Claude Agent SDK so any backend works the same way for both engines. |

### Validate against the conformance suite

`@computeragent/testing` ships portable cases that any conforming implementation must pass:

```ts
import { conformanceCases, runConformanceSuite } from "@computeragent/testing";

const report = await runConformanceSuite(() => yourDriver(yourHarness));
console.log(`${report.passed} passed, ${report.failed.length} failed`);
```

If the suite passes, your plug-in is a drop-in replacement.

For `SessionStore` specifically, the LSP gate is in `packages/session-store-sqlite/src/integration.test.ts` — clone that file, swap in your store, run it. Three assertions: round-trip, cross-process resume, `UNKNOWN_STORE` error registry hygiene.

## Code rules

These are enforced by review (no automated lint yet):

1. **No file over 250 LOC.** Hard cap. Split by responsibility.
2. **No abstraction without a second consumer.** YAGNI is non-negotiable.
3. **Pure functions for translations.** Side effects (fs, network) live at the edges.
4. **Errors are values at boundaries.** Use the `BadRequest` / `NotFound` / `Conflict` helpers in `packages/harness-server/src/error-mapper.ts`. Don't throw raw.
5. **Zod at the wire, types inside.** All inbound HTTP and outbound SSE bodies pass through zod. Internal code uses inferred types.
6. **No `any`.** `unknown` and narrow.
7. **No emojis in source, logs, or generated output.** Plain text everywhere.
8. **Imports go down the dependency graph.** `engine-*` and `identity-*` import from `@computeragent/protocol`. `harness-server` imports only from `@computeragent/protocol`. No cross-imports between engine and identity packages.
9. **Tests live next to source.** `foo.ts` + `foo.test.ts`. Vitest.

## Failure semantics

Documented contract — please don't change without an RFC:

- **`AuditSink`** — fire-and-forget. Errors swallowed. The harness keeps going.
- **`SessionStore`** — fail loud. Errors surface to the client via `ca_session_ended { reason: "error" }`. Data integrity matters.
- **`EngineDriver`** — fail loud. Errors surface as above.
- **`IdentityLoader`** — fail at session-create time as `400 BAD_REQUEST`.
- **Sibling sessions** — never share blast radius. One bad session must not corrupt another.

The `validateStoreEntries` server option lets deployments enforce the SessionStore contract at the framework boundary (drops malformed entries from `load()` before they reach the engine). Default OFF — framework is pass-through; engines validate.

## Versioning

We use [changesets](https://github.com/changesets/changesets) for cross-package versioning.

After making a change that affects published packages:

```bash
pnpm changeset           # describe what changed; pick semver bump per package
git add .changeset/
git commit -m "..."
```

When ready to release, the maintainer runs:

```bash
pnpm version-packages    # consumes pending changesets, bumps versions, updates CHANGELOGs
pnpm release             # builds all packages and publishes those that bumped
```

`@computeragent/examples` is private (the demo scripts) and excluded from versioning.

## Live tests

The `MONGO_URL` and `ANTHROPIC_API_KEY` env vars opt into live integration suites:

```bash
MONGO_URL="mongodb://..." pnpm --filter @computeragent/session-store-mongo test
ANTHROPIC_API_KEY="sk-..." bun run examples/wedge16-mongo-resume-demo.ts
```

CI runs the offline suite by default; the live ones skip cleanly when the env vars are absent.

## Pull request checklist

- [ ] `pnpm -r build` clean
- [ ] `pnpm -r typecheck` clean
- [ ] `pnpm -r test` clean
- [ ] If you added a published-package change, `pnpm changeset` was run
- [ ] If you added a new plug-in, a passing conformance run is included in the PR description
- [ ] No file added over 250 LOC

## License

All contributions are under [MIT](./LICENSE).
