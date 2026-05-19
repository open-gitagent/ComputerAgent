#!/usr/bin/env node
/**
 * CLI for `@computeragent/llm-proxy-openai`.
 *
 * Wires env vars to programmatic options + handles SIGINT/SIGTERM cleanly.
 *
 *   UPSTREAM_BASE=https://your-host \
 *   UPSTREAM_PATH=/v1/chat/completions \
 *   UPSTREAM_TOKEN=sk-... \
 *   UPSTREAM_MODEL=optional-model-override \
 *   PORT=8788 \
 *     anth-to-openai-proxy
 *
 * Or via `npx @computeragent/llm-proxy-openai`.
 */
import { startProxy } from "./proxy.js";

const port = Number(process.env.PORT ?? 8788);
const upstreamBase = process.env.UPSTREAM_BASE;
const upstreamToken = process.env.UPSTREAM_TOKEN;

if (!upstreamBase) {
  console.error("ERROR: UPSTREAM_BASE is required (e.g. https://agent-dev.test.studio.lyzr.ai)");
  process.exit(2);
}
if (!upstreamToken) {
  console.error("ERROR: UPSTREAM_TOKEN is required (Bearer token for the upstream)");
  process.exit(2);
}

const handle = await startProxy({
  port,
  upstream: {
    base: upstreamBase,
    path: process.env.UPSTREAM_PATH,
    token: upstreamToken,
    ...(process.env.UPSTREAM_MODEL ? { modelOverride: process.env.UPSTREAM_MODEL } : {}),
    ...(process.env.UPSTREAM_AUTH_SCHEME ? { authScheme: process.env.UPSTREAM_AUTH_SCHEME } : {}),
  },
  forwardMaxTokens: process.env.FORWARD_MAX_TOKENS === "1",
});

const shutdown = async (sig: string) => {
  console.error(`[proxy] received ${sig}, shutting down`);
  await handle.close().catch(() => {});
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
