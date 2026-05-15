# create-computeragent

Scaffold a runnable [ComputerAgent](https://github.com/open-gitagent/ComputerAgent) project in 60 seconds.

```bash
npx create-computeragent my-agent
cd my-agent
npm install
ANTHROPIC_API_KEY=sk-ant-... npm start
```

That's it. The output is a single TS file plus a `package.json` — no build tools, no boilerplate, just `runTask({...})` against a local substrate.

## What you get

```
my-agent/
├── package.json     # depends on @computeragent/sdk + @computeragent/runtime-local
├── index.ts         # one inline GAP agent + runTask call
├── README.md
└── .gitignore
```

`index.ts` is fully runnable. It defines an inline GAP agent (model + system prompt), boots a local subprocess, runs one turn, and prints the agent's reply.

## Next steps

- Swap the substrate: `npm install @computeragent/runtime-e2b` then replace `new LocalSubstrate()` with `new E2BSubstrate({apiKey})`.
- Add cross-process memory: pass `sessionStore: { kind: "file", options: { root: "./sessions" } }` and re-run with the same `sessionId`.
- Build a real GAP repo: see https://github.com/open-gitagent/gitagent-protocol.

## Options

```
npx create-computeragent <project-name> [--force]
```

`--force` lets you scaffold into a non-empty directory.

## License

MIT
