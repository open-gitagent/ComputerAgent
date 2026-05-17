/**
 * Entry point that runs INSIDE the local subprocess (or, for runtime-vzvm later,
 * inside the VM). Identical shape to runtime-e2b's sandbox-boot.ts — both bundle
 * the same set of engines and let `@anthropic-ai/claude-agent-sdk` + `gitclaw`
 * resolve from node_modules at runtime.
 *
 * Bundled with `bun build --target=node --format=esm`.
 */

import { serve } from "@hono/node-server";
import { createHarnessServer } from "@computeragent/harness-server";
import { ClaudeAgentEngine } from "@computeragent/engine-claude-agent-sdk";
import { GitAgentEngine } from "@computeragent/engine-gitagent";
import { DeepAgentsEngine } from "@computeragent/engine-deepagents";
import { GitAgentProtocolLoader } from "@computeragent/identity-gitagentprotocol";
import { createLogger, type SessionStore } from "@computeragent/protocol";
import { MongoSessionStore } from "@computeragent/session-store-mongo";

const PORT = Number(process.env.PORT ?? 7700);
const logger = createLogger({ component: "harness" });

const app = createHarnessServer({
  engines: {
    "claude-agent-sdk": new ClaudeAgentEngine(),
    "gitagent": new GitAgentEngine(),
    "deepagents": new DeepAgentsEngine(),
  },
  identityLoaders: { gitagentprotocol: new GitAgentProtocolLoader() },
  // `memory` and `file` are baked in by the framework — we just add Mongo here.
  // Builder reads MONGO_URL from process.env when the caller's wire-side
  // `sessionStore.options` omits `url` (the common case: clients send
  // `{ kind: "mongo" }`, the server holds the credential).
  sessionStores: {
    mongo: (options: unknown): SessionStore => {
      const o = (options ?? {}) as { url?: string; database?: string };
      const url = o.url ?? process.env.MONGO_URL;
      if (!url) {
        throw new Error(
          "mongo session store: MONGO_URL env var or options.url is required",
        );
      }
      // Database resolution precedence:
      //   per-request options.database  >  MONGO_DATABASE env  >  store's own default
      // Keeps the database name out of client request bodies for the common
      // single-database deployment.
      const database = o.database ?? process.env.MONGO_DATABASE;
      return new MongoSessionStore({
        url,
        ...(database ? { database } : {}),
      });
    },
  },
  logger,
});

serve({ fetch: app.fetch, port: PORT, hostname: "127.0.0.1" }, ({ port }) => {
  logger.info("ready", { url: `http://127.0.0.1:${port}` });
  process.stdout.write(`harness-server listening on 127.0.0.1:${port}\n`);
});
