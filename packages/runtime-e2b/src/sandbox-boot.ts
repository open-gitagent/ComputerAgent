/**
 * Entry point that runs INSIDE the E2B sandbox.
 *
 * Bundled with `bun build --target=node --format=esm` into a single .mjs file.
 * The sandbox runs `node harness.mjs` after `npm install`-ing the externalized
 * runtime deps:
 *   - `@anthropic-ai/claude-agent-sdk` (ESM-only; native CLI binary in optional dep)
 *   - `gitclaw` (does `require('../package.json')` at runtime — needs to live in
 *     real node_modules, not be bundled)
 *
 * Engines registered:
 *   - claude-agent-sdk
 *   - gitagent
 *
 * Identity loader:
 *   - gitagentprotocol
 */

import { serve } from "@hono/node-server";
import { createHarnessServer } from "@computeragent/harness-server";
import { ClaudeAgentEngine } from "@computeragent/engine-claude-agent-sdk";
import { GitAgentEngine } from "@computeragent/engine-gitagent";
import { DeepAgentsEngine } from "@computeragent/engine-deepagents";
import { GitAgentProtocolLoader } from "@computeragent/identity-gitagentprotocol";
import { createLogger } from "@computeragent/protocol";

const PORT = Number(process.env.PORT ?? 7700);
const logger = createLogger({ component: "harness" });

const app = createHarnessServer({
  engines: {
    "claude-agent-sdk": new ClaudeAgentEngine(),
    "gitagent": new GitAgentEngine(),
    "deepagents": new DeepAgentsEngine(),
  },
  identityLoaders: { gitagentprotocol: new GitAgentProtocolLoader() },
  logger,
});

serve({ fetch: app.fetch, port: PORT, hostname: "0.0.0.0" }, ({ port }) => {
  logger.info("ready", { url: `http://0.0.0.0:${port}` });
  process.stdout.write(`harness-server listening on 0.0.0.0:${port}\n`);
});
