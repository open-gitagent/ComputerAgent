# @computeragent/llm-proxy-openai

Anthropic Messages ↔ OpenAI Chat Completions **translator proxy**.

Accepts `POST /v1/messages` in Anthropic's Messages format and forwards to any OpenAI-Chat-Completions–compatible endpoint, translating both the request and the response (including streaming and tool calls).

Used by ComputerAgent so that engines whose underlying SDKs speak Anthropic Messages — `claude-agent-sdk` and `deepagents` (via `ChatAnthropic`) — can target OpenAI-compat backends like vLLM, LiteLLM, Together, Ollama, or any compatible inference gateway.

`gitagent` does **not** need this proxy — gitclaw natively speaks both protocols via `GITCLAW_MODEL_BASE_URL` + `provider:model@baseUrl` syntax.

## Run as a CLI

```bash
UPSTREAM_BASE=https://your-openai-compat-host \
UPSTREAM_PATH=/v1/chat/completions \
UPSTREAM_TOKEN=sk-... \
PORT=8788 \
  npx @computeragent/llm-proxy-openai
```

Then point your ComputerAgent run at the proxy:

```bash
curl -N -X POST http://127.0.0.1:18800/run \
  -H 'content-type: application/json' -H 'accept: text/event-stream' \
  -d '{
    "source": "github.com/<org>/<gap-repo>",
    "harness": "claude-agent-sdk",
    "envs": {
      "ANTHROPIC_BASE_URL": "http://127.0.0.1:8788",
      "ANTHROPIC_API_KEY":  "via-proxy"
    },
    "message": "Reply: PING"
  }'
```

## Run programmatically

```ts
import { startProxy } from "@computeragent/llm-proxy-openai";

const proxy = await startProxy({
  port: 8788,
  upstream: {
    base: "https://your-inference-gateway.example.com",
    path: "/v1/chat/completions",
    token: process.env.UPSTREAM_TOKEN!,
    modelOverride: "your-model-id", // optional; override client model
  },
});

// …
await proxy.close();
```

## Environment variables (CLI)

| Var | Required | Default | Notes |
|---|---|---|---|
| `UPSTREAM_BASE` | ✓ | — | Origin only, e.g. `https://your-host` |
| `UPSTREAM_TOKEN` | ✓ | — | Bearer token for the upstream |
| `UPSTREAM_PATH` | | `/v1/chat/completions` | Some hosts use `/v4/chat/completions` |
| `UPSTREAM_MODEL` | | — | Force this model on every upstream request (overrides client's Anthropic `model`) |
| `UPSTREAM_AUTH_SCHEME` | | `Bearer` | Replace with e.g. `Token` if your backend wants something else |
| `PORT` | | `8788` | Bind port |
| `FORWARD_MAX_TOKENS` | | `0` | Set to `1` to forward `max_tokens` — some backends blank the response when this field is set, so it's off by default |

## What the proxy translates

| Direction | Anthropic shape | OpenAI shape |
|---|---|---|
| Request | `system` field | first `system` message |
| Request | `messages[].content` text blocks | `messages[].content` strings |
| Request | assistant `tool_use` blocks | `messages[].tool_calls` |
| Request | user `tool_result` blocks | `messages[]` with `role: "tool"` + `tool_call_id` |
| Request | `tools[]` (Anthropic `input_schema`) | `tools[]` (OpenAI `function.parameters`) |
| Request | `tool_choice: {type:"auto" \| "any" \| "tool"}` | `tool_choice: "auto" \| "required" \| {type:"function",function:{name}}` |
| Response | `id`, `usage`, content blocks | reassembled from `choices[0].message` |
| Response | `tool_use` content blocks | from `tool_calls` |
| Response | `stop_reason: "tool_use" \| "max_tokens" \| "end_turn"` | mapped from `finish_reason` |
| Streaming | `message_start` → `content_block_start/delta/stop` → `message_delta` → `message_stop` | reassembled from `chat.completion.chunk` deltas (text + `tool_calls.function.arguments` partial JSON) |

## Endpoints

- `GET /health` → `{ ok: true, upstream }`
- `POST /v1/messages` → translated and forwarded to `<UPSTREAM_BASE><UPSTREAM_PATH>`

Anything else → `404`.

## Limitations

- **Text + tool calls only.** No image inputs, no audio. Anthropic's content blocks for those types are passed through as JSON strings if encountered, which most OpenAI-compat backends will reject.
- **No retry / circuit-breaker.** A single upstream timeout fails the request.
- **Stateless.** No request-id correlation, no metrics export. Bring your own observability.
- **`session_id` is informational.** The proxy adds it to outgoing OpenAI requests for backends that track it, but it's a string derived from the timestamp — proper session continuity comes from the client replaying `messages[]`, not from server-side state in the upstream.

## Verified compatibility

Tool calls round-trip end-to-end with `claude-agent-sdk` and `deepagents` against OpenAI-compat backends serving `/v1/chat/completions`. Streaming + tool-use partial-JSON deltas reassemble correctly.
