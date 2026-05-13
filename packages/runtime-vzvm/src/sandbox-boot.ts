/**
 * Entry point that runs INSIDE the VZ-backed VM (Tart). Identical to the
 * runtime-local and runtime-e2b bundles — same engines, same loader. Bundled
 * with `bun build --target=node --format=esm`.
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
  process.stdout.write(`harness-server listening on 0.0.0.0:${port}\n`);
});
