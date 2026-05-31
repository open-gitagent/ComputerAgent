/**
 * `@computeragent/llm-proxy-openai` — Anthropic Messages ↔ OpenAI Chat
 * Completions translator. Accepts the Anthropic Messages wire shape that
 * `claude-agent-sdk` and `deepagents` speak natively, and forwards to any
 * OpenAI-Chat-Completions endpoint (vLLM, LiteLLM, Together, Ollama, or
 * any compatible inference gateway).
 *
 * Two ways to use:
 *
 *   # CLI:
 *   UPSTREAM_BASE=https://your-openai-compat-host \
 *   UPSTREAM_PATH=/v1/chat/completions \
 *   UPSTREAM_TOKEN=sk-... \
 *   PORT=8788 \
 *     npx anth-to-openai-proxy
 *
 *   # Programmatic:
 *   import { startProxy } from "@computeragent/llm-proxy-openai";
 *   const proxy = await startProxy({
 *     port: 8788,
 *     upstream: {
 *       base: "https://your-openai-compat-host",
 *       path: "/v1/chat/completions",
 *       token: "sk-...",
 *     },
 *   });
 *   // … later:
 *   await proxy.close();
 *
 * Then point any ComputerAgent run at the proxy:
 *
 *   envs: {
 *     ANTHROPIC_BASE_URL: "http://127.0.0.1:8788",
 *     ANTHROPIC_API_KEY:  "via-proxy",  // anything; the upstream token is in the proxy
 *   }
 *
 * Tool calls round-trip in both directions — verified end-to-end with
 * claude-agent-sdk + deepagents both writing real files through their
 * tool surfaces against an OpenAI-compatible gateway.
 */
export { startProxy } from "./proxy.js";
export type { ProxyOptions, ProxyHandle, UpstreamConfig } from "./proxy.js";
