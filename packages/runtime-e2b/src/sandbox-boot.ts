/**
 * Entry point that runs INSIDE the E2B sandbox.
 *
 * Bundled with `bun build --target=node` into a single .cjs file so the sandbox
 * needs nothing more than `node` to execute it.
 *
 * Boots a harness server with the same plug-ins as examples/wedge1-server.ts:
 *   - claude-agent-sdk engine
 *   - gitagent engine
 *   - gitagentprotocol identity loader
 */

import { serve } from "@hono/node-server";
import { createHarnessServer } from "@computeragent/harness-server";
import { ClaudeAgentEngine } from "@computeragent/engine-claude-agent-sdk";
import { GitAgentEngine } from "@computeragent/engine-gitagent";
import { GitAgentProtocolLoader } from "@computeragent/identity-gitagentprotocol";

const PORT = Number(process.env.PORT ?? 7700);

const app = createHarnessServer({
  engines: {
    "claude-agent-sdk": new ClaudeAgentEngine(),
    "gitagent": new GitAgentEngine(),
  },
  identityLoaders: { gitagentprotocol: new GitAgentProtocolLoader() },
});

serve({ fetch: app.fetch, port: PORT, hostname: "0.0.0.0" }, ({ port }) => {
  // The SDK polls /v1/health to detect readiness — but a single explicit log
  // line on stdout helps when humans tail the sandbox's output for debugging.
  process.stdout.write(`harness-server listening on 0.0.0.0:${port}\n`);
});
