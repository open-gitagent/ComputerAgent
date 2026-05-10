/**
 * Wedge 1 reference server.
 *
 * Boots the harness server with the Wedge 1 reference plug-ins:
 *   - engine: claude-agent-sdk  (wraps @anthropic-ai/claude-agent-sdk)
 *   - engine: gitagent          (wraps gitclaw — open-gitagent/gitagent)
 *   - identity: gitagentprotocol (loads GitAgentProtocol repos for either engine)
 *
 * Run with Bun:
 *   ANTHROPIC_API_KEY=sk-... \
 *   OPENAI_API_KEY=sk-...    \
 *   bun run examples/wedge1-server.ts
 *
 * Either key alone is fine if you only plan to call one engine.
 */

import { createHarnessServer } from "@computeragent/harness-server";
import { ClaudeAgentEngine } from "@computeragent/engine-claude-agent-sdk";
import { GitAgentEngine } from "@computeragent/engine-gitagent";
import { GitAgentProtocolLoader } from "@computeragent/identity-gitagentprotocol";

const PORT = Number(process.env.PORT ?? 7700);

const baseApp = createHarnessServer({
  engines: {
    "claude-agent-sdk": new ClaudeAgentEngine(),
    "gitagent": new GitAgentEngine(),
  },
  identityLoaders: { gitagentprotocol: new GitAgentProtocolLoader() },
});

// One-line access log so we can see how many requests the client actually sends.
const app = {
  fetch(req: Request) {
    process.stderr.write(`${new Date().toISOString()} ${req.method} ${new URL(req.url).pathname}\n`);
    return baseApp.fetch(req);
  },
};

console.log(`harness-server listening on http://127.0.0.1:${PORT}`);
console.log(`  engines:           claude-agent-sdk, gitagent`);
console.log(`  identity loaders:  gitagentprotocol`);
console.log(`  endpoints:         POST /v1/chat   GET /v1/sessions/:id/events   GET /v1/health`);

// Bun's default per-request idleTimeout is 10s, which truncates long-running SSE
// streams (e.g. agent loops with tool use). 255 is the max; effectively "no
// timeout" for our use case. Wedge 1.5 will move this into a shared bootstrap.
export default { port: PORT, fetch: app.fetch, idleTimeout: 255 };
