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
import { GitAgentProtocolLoader } from "@computeragent/identity-gitagentprotocol";

const PORT = Number(process.env.PORT ?? 7700);

const app = createHarnessServer({
  engines: {
    "claude-agent-sdk": new ClaudeAgentEngine(),
    "gitagent": new GitAgentEngine(),
  },
  identityLoaders: { gitagentprotocol: new GitAgentProtocolLoader() },
});

serve({ fetch: app.fetch, port: PORT, hostname: "127.0.0.1" }, ({ port }) => {
  process.stdout.write(`harness-server listening on 127.0.0.1:${port}\n`);
});
