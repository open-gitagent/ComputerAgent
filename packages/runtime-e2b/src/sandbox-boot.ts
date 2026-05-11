/**
 * Entry point that runs INSIDE the E2B sandbox.
 *
 * Bundled with `bun build --target=node` into a single .cjs file so the sandbox
 * needs nothing more than `node` to execute it.
 *
 * Boots a harness server with the engines that bundle cleanly to a single file:
 *   - claude-agent-sdk engine
 *   - gitagentprotocol identity loader
 *
 * Note: the `gitagent` engine is intentionally NOT in this bundle because
 * `gitclaw` does `require('../package.json')` at runtime, which Bun's bundler
 * can't auto-include into a single .cjs file. Adding gitagent to the E2B
 * substrate is a Wedge 3b.5 task: either mark gitclaw external + npm-install
 * it inside the sandbox, or build a custom E2B template with both engines
 * pre-installed via real npm install.
 */

import { serve } from "@hono/node-server";
import { createHarnessServer } from "@computeragent/harness-server";
import { ClaudeAgentEngine } from "@computeragent/engine-claude-agent-sdk";
import { GitAgentProtocolLoader } from "@computeragent/identity-gitagentprotocol";

const PORT = Number(process.env.PORT ?? 7700);

const app = createHarnessServer({
  engines: {
    "claude-agent-sdk": new ClaudeAgentEngine(),
  },
  identityLoaders: { gitagentprotocol: new GitAgentProtocolLoader() },
});

serve({ fetch: app.fetch, port: PORT, hostname: "0.0.0.0" }, ({ port }) => {
  // The SDK polls /v1/health to detect readiness — but a single explicit log
  // line on stdout helps when humans tail the sandbox's output for debugging.
  process.stdout.write(`harness-server listening on 0.0.0.0:${port}\n`);
});
