# @computeragent/session-store-mongo

MongoDB-backed `SessionStore` for the ComputerAgent harness. Plug-in implementation of the Claude Agent SDK's native `SessionStore` contract — enables cross-process conversation continuation when sessions live in a shared database instead of on local disk.

## Install

```bash
pnpm add @computeragent/session-store-mongo
```

## Use

Register the store with the harness server at boot:

```ts
import { createHarnessServer } from "@computeragent/harness-server";
import { MongoSessionStore } from "@computeragent/session-store-mongo";

const app = createHarnessServer({
  engines: { /* ... */ },
  identityLoaders: { /* ... */ },
  sessionStores: {
    mongo: (options) => new MongoSessionStore({
      url: process.env.MONGO_URL!,
      database: "computeragent_sessions",
      ...(options as object ?? {}),
    }),
  },
});
```

Then have any client request the store by `kind`:

```ts
const agent = new ComputerAgent({
  source: "...",
  harness: "claude-agent-sdk",
  sessionStore: { kind: "mongo" },
  sessionId: previousSessionId,  // for resume
  envs: { ANTHROPIC_API_KEY: "..." },
});
```

The server-side builder receives the wire-side `options` field; the SDK never carries connection credentials over the wire — keep them server-side.

## Storage layout

One document per session under the `sessions` collection of the configured database (default: `computeragent_sessions`):

```json
{
  "_id": "<sessionId>",
  "projectKey": "<engine-derived>",
  "entries": [ /* SessionStoreEntry */ ],
  "updatedAt": <Date>
}
```

`entries[]` follows the Claude Agent SDK's [`SessionStoreEntry`](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) shape — JSONL-equivalent records the SDK appends per turn (user messages, assistant responses, tool calls, system events).

## Architecture notes

- **Two engines, one port.** The `SessionStore` interface is engine-agnostic. The Claude Agent engine consumes it natively (the SDK reads/writes through it). The gitagent engine currently manages its own filesystem session format and ignores `ctx.sessionStore`; a future `GitclawSessionStoreAdapter` can mirror gitclaw's session dir into any `SessionStore` for symmetric resume across engines.
- **Idempotency.** Entries are deduplicated by `uuid`. Re-appends of an entry already present are no-ops — safe for SDK retries and `importSessionToStore` replays.
- **Single-writer.** A simple `load → filter → write` cycle. Concurrent writes against the same `sessionId` from different harness processes can interleave; the SDK's flow is single-writer per session, which makes this correct in practice. Multi-writer parallelism (e.g., a fan-out farm against one logical session) would require a transactional update pipeline — captured as future work.

## Configuration

```ts
new MongoSessionStore({
  url: "mongodb://user:pass@host:port/admin",  // required
  database: "computeragent_sessions",          // default
  collection: "sessions",                      // default
  clientOptions: { /* MongoClientOptions */ }, // optional, forwarded to driver
});
```

`close()` releases the underlying `MongoClient` cleanly. The store auto-connects on first `append`/`load`/`size`/`listSessions` call; explicit `connect()` is offered for callers that want to surface connection errors at boot.

## Tests

```bash
MONGO_URL="mongodb://..." pnpm --filter @computeragent/session-store-mongo test
```

Live integration tests use ephemeral `ca_test_<random>` databases that are dropped on teardown — safe to run against shared clusters without polluting other apps' data. With `MONGO_URL` unset the live suite is skipped automatically.
