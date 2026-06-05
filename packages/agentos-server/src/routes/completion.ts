// Direct Claude completion proxy — a thin, agent-less chat endpoint used by the
// home screen's quick chat. Unlike /agents/:name/run and the sandbox chat
// (which go through the harness + a registered agent), this talks straight to
// the Anthropic Messages API with the server's ANTHROPIC_API_KEY, so the user
// can chat without picking/registering an agent.
//
//   POST /agentos/api/completion
//     body: { messages: [{ role: "user"|"assistant", content: string }],
//             system?: string, model?: string }
//          (also accepts { message: string } as a single-turn shortcut)
//     resp: SSE — `event: delta {text}` per chunk, then `event: done`,
//           or `event: error {message}`.
//
// The Anthropic key never leaves the server; only the streamed text does.

import { Router, type Router as IRouter } from "express";
import { authorize } from "../auth/authorize.js";

export const completionRouter: IRouter = Router();

type ChatMsg = { role: "user" | "assistant"; content: string };

const ANTHROPIC_BASE = (process.env["ANTHROPIC_BASE_URL"] ?? "https://api.anthropic.com").replace(/\/+$/, "");
const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MODEL =
  process.env["AGENTOS_COMPLETION_MODEL"] ?? process.env["AGENTOS_DEFAULT_MODEL"] ?? "claude-haiku-4-5";
const MAX_TOKENS = parseInt(process.env["AGENTOS_COMPLETION_MAX_TOKENS"] ?? "4096", 10);

function normalizeMessages(body: Record<string, unknown>): ChatMsg[] {
  const raw = body["messages"];
  if (Array.isArray(raw)) {
    return raw
      .map((m) => {
        const role = (m as { role?: unknown }).role === "assistant" ? "assistant" : "user";
        const content = String((m as { content?: unknown }).content ?? "").trim();
        return { role, content } as ChatMsg;
      })
      .filter((m) => m.content.length > 0);
  }
  // Single-turn shortcut.
  const one = typeof body["message"] === "string" ? body["message"].trim() : "";
  return one ? [{ role: "user", content: one }] : [];
}

completionRouter.post("/completion", authorize("completion:run"), async (req, res, next) => {
  try {
    const key = process.env["ANTHROPIC_API_KEY"];
    if (!key) {
      return res.status(503).json({ error: { code: "NO_API_KEY", message: "ANTHROPIC_API_KEY not configured on the server" } });
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const messages = normalizeMessages(body);
    if (messages.length === 0) {
      return res.status(400).json({ error: { code: "BAD_REQUEST", message: "`messages` (or `message`) required" } });
    }
    const model = typeof body["model"] === "string" && body["model"] ? body["model"] : DEFAULT_MODEL;
    const system = typeof body["system"] === "string" ? body["system"] : undefined;

    // Abort the upstream call if the browser disconnects mid-stream.
    const ctl = new AbortController();
    res.on("close", () => ctl.abort());

    const upstream = await fetch(`${ANTHROPIC_BASE}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": ANTHROPIC_VERSION,
        accept: "text/event-stream",
      },
      body: JSON.stringify({ model, max_tokens: MAX_TOKENS, stream: true, ...(system ? { system } : {}), messages }),
      signal: ctl.signal,
    });

    if (!upstream.ok || !upstream.body) {
      const detail = await upstream.text().catch(() => "");
      return res
        .status(upstream.status === 401 ? 502 : upstream.status)
        .json({ error: { code: "UPSTREAM", message: `Anthropic ${upstream.status}: ${detail.slice(0, 300)}` } });
    }

    // Switch to SSE and translate Anthropic's event stream into our simple
    // delta/done/error frames the frontend's streamCompletion understands.
    res.status(200);
    res.setHeader("content-type", "text/event-stream");
    res.setHeader("cache-control", "no-cache, no-transform");
    res.setHeader("connection", "keep-alive");
    res.flushHeaders?.();

    const write = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buf = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          let data: unknown = null;
          for (const line of frame.split("\n")) {
            if (line.startsWith("data: ")) {
              try { data = JSON.parse(line.slice(6)); } catch { /* skip non-JSON (e.g. ping) */ }
            }
          }
          if (!data || typeof data !== "object") continue;
          const d = data as { type?: string; delta?: { type?: string; text?: string }; error?: { message?: string } };
          if (d.type === "content_block_delta" && d.delta?.type === "text_delta" && typeof d.delta.text === "string") {
            write("delta", { text: d.delta.text });
          } else if (d.type === "error") {
            write("error", { message: d.error?.message ?? "completion error" });
          }
          // message_stop / other control frames need no client signal.
        }
      }
      write("done", {});
    } catch (err) {
      // Client aborts surface as AbortError — nothing to report then.
      if ((err as Error)?.name !== "AbortError") {
        try { write("error", { message: (err as Error).message }); } catch { /* res already closed */ }
      }
    } finally {
      res.end();
    }
  } catch (err) { next(err); }
});
