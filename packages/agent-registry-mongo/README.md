# @computeragent/agent-registry-mongo

MongoDB-backed agent registry + per-run audit log + `AgentTelemetry` implementation for `ComputerAgent`.

Use this when ComputerAgent runs as a **library** inside an existing worker (e.g. a Temporal worker pod, a CLI batch job, a serverless function) and you want the [AgentOS dashboard](https://github.com/open-gitagent/ComputerAgent) to see every run with no extra orchestration. Pass the telemetry instance to the SDK, and the SDK fires lifecycle hooks that upsert to `agent_registry` and append to `agent_logs`.

## Install

```bash
npm install @computeragent/agent-registry-mongo
```

## Use

```ts
import { ComputerAgent, LocalSubstrate } from "computeragent";
import { MongoTelemetry } from "@computeragent/agent-registry-mongo";

const telemetry = new MongoTelemetry({
  url: process.env.MONGO_URL!,
  database: "agentos",
  agent: {
    name: "devsupport-agent",
    label: "DevSupport",
    source: "github.com/nord/devsupport-agent",
    harness: "claude-agent-sdk",
    model: "bedrock/anthropic.claude-sonnet-4-20250514-v1:0",
    registeredBy: process.env.HOSTNAME, // pod name, "ci", etc.
  },
});

await using agent = new ComputerAgent({
  source: {type: "git", url: "github.com/nord/devsupport-agent"},
  harness: "claude-agent-sdk",
  runtime: new LocalSubstrate(),
  envs: { CLAUDE_CODE_USE_BEDROCK: "1", AWS_REGION: "us-west-2" },
  telemetry,
});

const result = await agent.chat("hello");
```

That's it. On construct, an upsert lands in `agent_registry`. On every `chat()`, a document lands in `agent_logs` with `usage`, `durationMs`, `ok`, `error`, and a truncated reply.

## Collections

### `agent_registry`

```ts
{
  _id: "devsupport-agent",          // agent name (unique)
  label: "DevSupport",
  harness: "claude-agent-sdk",
  source: "github.com/nord/...",    // IdentitySource JSON
  model: "bedrock/anthropic.claude-sonnet-4-...",
  registeredBy: "worker-abc-123",
  registeredAt: ISODate("..."),
  updatedAt:    ISODate("..."),
  lastSeen:     ISODate("..."),
}
```

### `agent_logs`

```ts
{
  _id: "log_<uuid>",
  ts: ISODate("..."),
  source: "library",                // | "slack" | "web" | "schedule" | ...
  agentName: "devsupport-agent",
  sessionId: "session_...",
  query: "user message text",
  reply: "assistant reply text",
  ok: true,
  durationMs: 12345,
  inputTokens: 1200,
  outputTokens: 350,
  costUsd: 0.012,
}
```

## Lower-level API

If you want CRUD beyond the telemetry hook (e.g. unregistering an agent from a teardown script):

```ts
import { AgentRegistry, AgentLogStore } from "@computeragent/agent-registry-mongo";

const reg = new AgentRegistry({url, database: "agentos"});
await reg.register({name: "agent-1", harness: "claude-agent-sdk", source: "..."});
await reg.list();
await reg.unregister("agent-1");
await reg.close();

const logs = new AgentLogStore({url, database: "agentos"});
const recent = await logs.list({agentName: "agent-1", limit: 20});
```

## Connection sharing

If your app already manages a `MongoClient`, pass it in to avoid a second pool:

```ts
const client = new MongoClient(process.env.MONGO_URL!);
await client.connect();
const telemetry = new MongoTelemetry({
  url: process.env.MONGO_URL!,
  database: "agentos",
  agent: {name: "devsupport-agent", harness: "claude-agent-sdk", source: "..."},
  client,                            // shared
});
// telemetry.onClose() won't close `client` — you own its lifecycle.
```

## Error policy

Telemetry calls are fire-and-forget on the SDK side — exceptions thrown here never reach the agent's chat result. For diagnostics, pass an `onError` callback:

```ts
new MongoTelemetry({
  ...,
  onError: (err, op) => myLogger.warn({err, op}, "telemetry write failed"),
});
```
