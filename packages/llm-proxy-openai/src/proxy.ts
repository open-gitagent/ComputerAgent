import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";

/**
 * Where to forward Anthropic Messages requests once translated to OpenAI shape.
 */
export interface UpstreamConfig {
  /** Origin of the OpenAI-compat endpoint, e.g. `https://your-host`. */
  readonly base: string;
  /** Path under `base`, e.g. `/v1/chat/completions` or `/v4/chat/completions`. */
  readonly path?: string;
  /** Bearer token to send as `Authorization: Bearer <token>`. */
  readonly token: string;
  /**
   * Force this model id on every upstream request, overriding the client's
   * Anthropic `model` field. Useful when the OpenAI-compat backend uses a
   * model id the client wouldn't normally pick (e.g. a Mongo ObjectId).
   */
  readonly modelOverride?: string;
  /** Override the `Authorization` scheme. Defaults to `Bearer`. */
  readonly authScheme?: string;
}

export interface ProxyOptions {
  /** Port to listen on. Default 8788. */
  readonly port?: number;
  /** Host to bind. Default `127.0.0.1`. */
  readonly host?: string;
  readonly upstream: UpstreamConfig;
  /** Set true to forward `max_tokens` upstream. Default false — some backends (Lyzr) blank the response when set. */
  readonly forwardMaxTokens?: boolean;
  /** Custom logger; default is console.error with `[proxy]` prefix. */
  readonly log?: (...args: unknown[]) => void;
}

export interface ProxyHandle {
  readonly port: number;
  readonly host: string;
  close(): Promise<void>;
}

/**
 * Start the translator proxy. Returns a handle with the bound port and a
 * `close()` to shut it down. The HTTP server listens on `host:port` and
 * accepts:
 *
 *   GET  /health           → liveness check (always 200)
 *   POST /v1/messages      → translates to upstream `/v1/chat/completions`,
 *                            forwards, translates response back
 *
 * Any other path returns 404.
 */
export async function startProxy(opts: ProxyOptions): Promise<ProxyHandle> {
  const port = opts.port ?? 8788;
  const host = opts.host ?? "127.0.0.1";
  const upstreamPath = opts.upstream.path ?? "/v1/chat/completions";
  const upstreamUrl = opts.upstream.base.replace(/\/+$/, "") + upstreamPath;
  const log = opts.log ?? ((...a: unknown[]) => console.error("[proxy]", ...a));

  const server = createServer(async (req, res) => {
    try {
      await handleRequest(req, res, {
        upstreamUrl,
        token: opts.upstream.token,
        modelOverride: opts.upstream.modelOverride,
        authScheme: opts.upstream.authScheme ?? "Bearer",
        forwardMaxTokens: Boolean(opts.forwardMaxTokens),
        log,
      });
    } catch (err) {
      log("unhandled error:", err);
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { type: "api_error", message: (err as Error).message } }));
      }
    }
  });

  await new Promise<void>((resolve) => server.listen(port, host, () => resolve()));
  log(`listening on http://${host}:${port}`);
  log(`upstream: ${upstreamUrl}`);
  log(`model override: ${opts.upstream.modelOverride || "(use client model)"}`);

  return {
    port,
    host,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

// ── request handling ─────────────────────────────────────────────────────

interface HandlerCtx {
  upstreamUrl: string;
  token: string;
  modelOverride?: string;
  authScheme: string;
  forwardMaxTokens: boolean;
  log: (...args: unknown[]) => void;
}

async function handleRequest(req: IncomingMessage, res: ServerResponse, ctx: HandlerCtx): Promise<void> {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, upstream: ctx.upstreamUrl }));
    return;
  }
  if (req.method !== "POST" || !req.url || !req.url.includes("/v1/messages")) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({
      error: {
        type: "not_found_error",
        message: `${req.method} ${req.url} — proxy only serves POST /v1/messages`,
      },
    }));
    return;
  }

  let raw = "";
  req.setEncoding("utf8");
  for await (const chunk of req as AsyncIterable<string>) raw += chunk;
  let body: AnthropicRequest;
  try { body = JSON.parse(raw) as AnthropicRequest; }
  catch (e) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { type: "invalid_request_error", message: (e as Error).message } }));
    return;
  }

  const wantStream = Boolean(body.stream);
  const upstreamBody = anthropicToOpenAI(body, ctx);
  ctx.log(`→ upstream model=${upstreamBody.model} stream=${wantStream} msgs=${upstreamBody.messages.length} tools=${upstreamBody.tools?.length ?? 0}`);

  let upstreamRes: Response;
  try {
    upstreamRes = await fetch(ctx.upstreamUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "accept": wantStream ? "text/event-stream" : "application/json",
        "Authorization": `${ctx.authScheme} ${ctx.token}`,
      },
      body: JSON.stringify(upstreamBody),
    });
  } catch (e) {
    ctx.log("upstream fetch failed:", (e as Error).message);
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { type: "api_error", message: `upstream unreachable: ${(e as Error).message}` } }));
    return;
  }

  if (!upstreamRes.ok) {
    const text = await upstreamRes.text();
    ctx.log(`upstream ${upstreamRes.status}:`, text.slice(0, 200));
    res.writeHead(upstreamRes.status, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { type: "api_error", message: `upstream ${upstreamRes.status}: ${text.slice(0, 500)}` } }));
    return;
  }

  if (wantStream) {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "connection": "keep-alive",
    });
    await pipeStream(upstreamRes, res, body.model ?? upstreamBody.model, ctx.log);
    return;
  }

  const j = (await upstreamRes.json()) as OpenAIResponse;
  const anth = openaiToAnthropic(j, body.model ?? upstreamBody.model);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(anth));
}

// ── REQUEST: Anthropic /v1/messages → OpenAI chat completions ─────────────

interface AnthropicRequest {
  model: string;
  system?: string | Array<{ type?: string; text?: string } | string>;
  messages: Array<AnthropicMessage>;
  tools?: Array<{ name: string; description?: string; input_schema?: unknown }>;
  tool_choice?: { type: "auto" | "any" | "tool"; name?: string };
  stream?: boolean;
  max_tokens?: number;
}
interface AnthropicMessage {
  role: "user" | "assistant" | string;
  content: string | Array<AnthropicContentBlock>;
}
type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input?: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: unknown };

interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}
interface OpenAIRequest {
  model: string;
  messages: OpenAIMessage[];
  tools?: Array<{ type: "function"; function: { name: string; description?: string; parameters?: unknown } }>;
  tool_choice?: "auto" | "required" | { type: "function"; function: { name: string } };
  stream?: boolean;
  user?: string;
  session_id?: string;
  max_tokens?: number;
}

function anthropicToOpenAI(req: AnthropicRequest, ctx: HandlerCtx): OpenAIRequest {
  const out: OpenAIMessage[] = [];

  if (req.system) {
    const sys = Array.isArray(req.system)
      ? req.system.map((b) => (typeof b === "string" ? b : b.text ?? "")).join("\n")
      : String(req.system);
    out.push({ role: "system", content: sys });
  }

  for (const m of req.messages) {
    if (typeof m.content === "string") {
      out.push({ role: m.role as OpenAIMessage["role"], content: m.content });
      continue;
    }
    if (!Array.isArray(m.content)) continue;

    if (m.role === "assistant") {
      // Combine text + tool_use blocks. Text → assistant.content; tool_use → assistant.tool_calls.
      const text = m.content
        .filter((b): b is { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text)
        .join("");
      const tool_calls = m.content
        .filter((b): b is { type: "tool_use"; id: string; name: string; input?: Record<string, unknown> } => b.type === "tool_use")
        .map((b) => ({
          id: b.id,
          type: "function" as const,
          function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
        }));
      const msg: OpenAIMessage = { role: "assistant", content: text || null };
      if (tool_calls.length > 0) msg.tool_calls = tool_calls;
      out.push(msg);
      continue;
    }

    if (m.role === "user") {
      // text → user; tool_result → separate role:"tool" messages
      const texts: string[] = [];
      const toolMsgs: OpenAIMessage[] = [];
      for (const b of m.content) {
        if (b.type === "text") texts.push(b.text);
        else if (b.type === "tool_result") {
          let content: string;
          if (Array.isArray(b.content)) {
            content = (b.content as Array<{ type?: string; text?: string }>)
              .map((x) => (x.type === "text" ? x.text ?? "" : JSON.stringify(x)))
              .join("\n");
          } else if (typeof b.content === "string") {
            content = b.content;
          } else {
            content = JSON.stringify(b.content);
          }
          toolMsgs.push({ role: "tool", tool_call_id: b.tool_use_id, content });
        }
      }
      if (texts.length > 0) out.push({ role: "user", content: texts.join("\n") });
      out.push(...toolMsgs);
      continue;
    }

    out.push({ role: m.role as OpenAIMessage["role"], content: JSON.stringify(m.content) });
  }

  const body: OpenAIRequest = {
    model: ctx.modelOverride || req.model,
    messages: out,
    user: "anth-proxy",
    session_id: `${ctx.modelOverride || req.model}-proxy-${Date.now()}`,
  };
  if (req.stream) body.stream = true;
  if (ctx.forwardMaxTokens && typeof req.max_tokens === "number") body.max_tokens = req.max_tokens;

  if (Array.isArray(req.tools) && req.tools.length > 0) {
    body.tools = req.tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description ?? "",
        parameters: t.input_schema ?? { type: "object", properties: {} },
      },
    }));
  }
  if (req.tool_choice) {
    if (req.tool_choice.type === "auto") body.tool_choice = "auto";
    else if (req.tool_choice.type === "any") body.tool_choice = "required";
    else if (req.tool_choice.type === "tool" && req.tool_choice.name) {
      body.tool_choice = { type: "function", function: { name: req.tool_choice.name } };
    }
  }
  return body;
}

// ── RESPONSE: OpenAI chat completion → Anthropic Messages (non-streaming) ──

interface OpenAIResponse {
  choices?: Array<{
    message?: { content?: string | null; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> };
    finish_reason?: string;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

interface AnthropicResponse {
  id: string;
  type: "message";
  role: "assistant";
  model: string;
  content: AnthropicContentBlock[];
  stop_reason: string;
  stop_sequence: null;
  usage: { input_tokens: number; output_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number };
}

function openaiToAnthropic(resp: OpenAIResponse, originalModel: string): AnthropicResponse {
  const choice = resp.choices?.[0] ?? {};
  const msg = choice.message ?? {};
  const content: AnthropicContentBlock[] = [];
  if (typeof msg.content === "string" && msg.content.length > 0) {
    content.push({ type: "text", text: msg.content });
  }
  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      let input: Record<string, unknown> = {};
      try { input = JSON.parse(tc.function?.arguments ?? "{}"); } catch { /* keep empty */ }
      content.push({
        type: "tool_use",
        id: tc.id ?? `toolu_${randomUUID().slice(0, 24)}`,
        name: tc.function?.name ?? "unknown",
        input,
      });
    }
  }
  const finish = choice.finish_reason ?? "stop";
  const stop_reason =
    finish === "tool_calls" ? "tool_use" :
    finish === "length"     ? "max_tokens" :
    "end_turn";

  return {
    id: `msg_${randomUUID().slice(0, 24)}`,
    type: "message",
    role: "assistant",
    model: originalModel,
    content,
    stop_reason,
    stop_sequence: null,
    usage: {
      input_tokens: resp.usage?.prompt_tokens ?? 0,
      output_tokens: resp.usage?.completion_tokens ?? 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  };
}

// ── STREAMING translation ─────────────────────────────────────────────────

async function pipeStream(
  upstreamRes: Response,
  out: ServerResponse,
  originalModel: string,
  log: (...args: unknown[]) => void,
): Promise<void> {
  const msgId = `msg_${randomUUID().slice(0, 24)}`;
  const writeEvent = (event: string, data: unknown) =>
    out.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  writeEvent("message_start", {
    type: "message_start",
    message: {
      id: msgId, type: "message", role: "assistant", model: originalModel,
      content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  });

  let textBlockIndex: number | false = false;
  let nextAnthIndex = 0;
  const toolBlocks = new Map<number, { anthIndex: number; id: string; name: string; argsBuf: string }>();
  let finish = "stop";
  let usage: { prompt_tokens?: number; completion_tokens?: number } | null = null;
  let accumulatedText = "";

  const ensureTextBlock = () => {
    if (textBlockIndex !== false) return;
    textBlockIndex = nextAnthIndex++;
    writeEvent("content_block_start", {
      type: "content_block_start", index: textBlockIndex,
      content_block: { type: "text", text: "" },
    });
  };

  const startToolBlock = (openaiIdx: number, id: string, name: string) => {
    const anthIndex = nextAnthIndex++;
    toolBlocks.set(openaiIdx, { anthIndex, id, name, argsBuf: "" });
    writeEvent("content_block_start", {
      type: "content_block_start", index: anthIndex,
      content_block: { type: "tool_use", id, name, input: {} },
    });
    return toolBlocks.get(openaiIdx)!;
  };

  const body = upstreamRes.body;
  if (!body) { out.end(); return; }
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
      for (const line of frame.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        const payload = line.slice(6).trim();
        if (payload === "[DONE]") continue;
        try {
          const d = JSON.parse(payload) as {
            choices?: Array<{
              delta?: { content?: string; tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> };
              finish_reason?: string;
            }>;
            usage?: { prompt_tokens?: number; completion_tokens?: number };
          };
          const c0 = d.choices?.[0];
          if (!c0) continue;
          const delta = c0.delta ?? {};

          if (typeof delta.content === "string" && delta.content.length > 0) {
            ensureTextBlock();
            accumulatedText += delta.content;
            writeEvent("content_block_delta", {
              type: "content_block_delta", index: textBlockIndex,
              delta: { type: "text_delta", text: delta.content },
            });
          }

          if (Array.isArray(delta.tool_calls)) {
            for (const tcDelta of delta.tool_calls) {
              const oi = tcDelta.index ?? 0;
              let block = toolBlocks.get(oi);
              if (!block) {
                const id = tcDelta.id ?? `toolu_${randomUUID().slice(0, 24)}`;
                const name = tcDelta.function?.name ?? "unknown";
                block = startToolBlock(oi, id, name);
              }
              const argsPiece = tcDelta.function?.arguments;
              if (typeof argsPiece === "string" && argsPiece.length > 0) {
                block.argsBuf += argsPiece;
                writeEvent("content_block_delta", {
                  type: "content_block_delta", index: block.anthIndex,
                  delta: { type: "input_json_delta", partial_json: argsPiece },
                });
              }
            }
          }

          if (c0.finish_reason) finish = c0.finish_reason;
          if (d.usage) usage = d.usage;
        } catch (e) { log("stream parse error:", (e as Error).message); }
      }
    }
  }

  if (textBlockIndex !== false) writeEvent("content_block_stop", { type: "content_block_stop", index: textBlockIndex });
  for (const block of toolBlocks.values()) {
    writeEvent("content_block_stop", { type: "content_block_stop", index: block.anthIndex });
  }

  const stop_reason =
    finish === "tool_calls" ? "tool_use" :
    finish === "length"     ? "max_tokens" :
    "end_turn";

  writeEvent("message_delta", {
    type: "message_delta",
    delta: { stop_reason, stop_sequence: null },
    usage: {
      input_tokens: usage?.prompt_tokens ?? 0,
      output_tokens: usage?.completion_tokens ?? Math.ceil(accumulatedText.length / 4),
    },
  });
  writeEvent("message_stop", { type: "message_stop" });
  out.end();
  log(`stream done: text=${accumulatedText.length}c tools=${toolBlocks.size} stop=${stop_reason}`);
}
