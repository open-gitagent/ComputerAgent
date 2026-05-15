# computeragent

> Run any AI agent, anywhere, with any loop, and any memory backend.

The umbrella entry point for [ComputerAgent](https://github.com/open-gitagent/ComputerAgent). One install, one import, a running agent.

```bash
npm install computeragent
```

```ts
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
        "model:",
        "  preferred: claude-haiku-4-5-20251001",
      ].join("\n"),
      "SOUL.md": "Respond in one short sentence.",
    },
  },
  harness: "claude-agent-sdk",
  envs: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY! },
  runtime: new LocalSubstrate(),
  message: "Say hi.",
});
```

## What's in the box

This package re-exports:

- **`ComputerAgent`**, **`ChatHandle`**, **`runTask`** — the user-facing SDK
- **`LocalSubstrate`** — the default (subprocess) runtime
- All the SDK's TypeScript types

That's enough for a complete agent in one import. For other substrates, session stores, or engines, install the scoped packages alongside:

```bash
npm install @computeragent/runtime-e2b              # cloud sandbox
npm install @computeragent/runtime-vzvm             # Apple VZ via Tart
npm install @computeragent/session-store-mongo      # MongoDB-backed memory
npm install @computeragent/session-store-sqlite     # SQLite-backed memory
npm install @computeragent/engine-gitagent          # gitclaw engine
```

## Why an umbrella package

`computeragent` is the one-line entry point for the common case. The 13 scoped `@computeragent/*` packages stay independently publishable for power users who want minimal deps (a custom `harness-server` build with no SDK, or just the protocol types for a non-JS client).

This is the same shape as `next` (the umbrella) + `@next/*` (the parts) — install the one you need, ignore the rest.

## See also

- **Repo / docs:** https://github.com/open-gitagent/ComputerAgent
- **Scaffold a project in 60 seconds:** `npx create-computeragent my-agent`
- **Conformance suite for plug-in authors:** `@computeragent/testing`

## License

[MIT](../../LICENSE)
