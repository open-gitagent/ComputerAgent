// Anthropic-compatible model gateway — a transparent reverse proxy for the
// Messages API. Unlike /completion (a custom SSE shape for the home-screen
// chat), this faithfully forwards an Anthropic `/v1/messages` request to the
// real API using the server's ANTHROPIC_API_KEY and streams the response back
// byte-for-byte. So a client (e.g. the Claude CLI behind the SDK's
// `claude-agent-sdk` engine) can point `ANTHROPIC_BASE_URL` at
//   <agentos>/agentos/api/v1
// and authenticate with its own AgentOS API key (`cak_…`, sent as
// `Authorization: Bearer`) instead of holding the Anthropic key — the Anthropic
// key never leaves the server.
//
//   POST /agentos/api/v1/messages   (cak_-authed via the dashboard boundary +
//                                    `completion:run`)
//     body:  a verbatim Anthropic Messages request (model, messages, system,
//            max_tokens, tools, stream, …)
//     resp:  the upstream status + body, streamed unchanged (SSE when
//            `stream:true`, JSON otherwise).
//
// NB: the request body is parsed by the global `express.json({limit:"1mb"})`
// and re-serialized here, so the gateway inherits that 1 MB request cap.

import { Router, type Router as IRouter } from "express";
import { authorize } from "../auth/authorize.js";

export const messagesRouter: IRouter = Router();

const ANTHROPIC_BASE = (process.env["ANTHROPIC_BASE_URL"] ?? "https://api.anthropic.com").replace(/\/+$/, "");
const ANTHROPIC_VERSION = "2023-06-01";

messagesRouter.post("/messages", authorize("completion:run"), async (req, res, next) => {
  try {
    const key = process.env["ANTHROPIC_API_KEY"];
    if (!key) {
      return res
        .status(503)
        .json({ error: { code: "NO_API_KEY", message: "ANTHROPIC_API_KEY not configured on the server" } });
    }

    const body = (req.body ?? {}) as Record<string, unknown>;

    // Forward the auth-stripped request with the SERVER's key. Pass through the
    // client's anthropic-version / anthropic-beta when present (faithful proxy).
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": req.header("anthropic-version") || ANTHROPIC_VERSION,
    };
    const beta = req.header("anthropic-beta");
    if (beta) headers["anthropic-beta"] = beta;
    const accept = req.header("accept");
    if (accept) headers["accept"] = accept;

    // Abort the upstream call if the client disconnects mid-stream.
    const ctl = new AbortController();
    res.on("close", () => ctl.abort());

    const upstream = await fetch(`${ANTHROPIC_BASE}/v1/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: ctl.signal,
    });

    // Mirror the upstream status + the headers a Messages client cares about.
    res.status(upstream.status);
    for (const h of ["content-type", "request-id", "anthropic-ratelimit-requests-remaining"]) {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    res.setHeader("cache-control", "no-cache, no-transform");
    res.setHeader("x-accel-buffering", "no"); // defeat any proxy buffering for SSE
    res.flushHeaders?.();

    if (!upstream.body) {
      res.end();
      return;
    }

    // Pipe the raw bytes through unchanged — works for both the SSE stream
    // (stream:true) and a single JSON body. No reshaping.
    const reader = upstream.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
        (res as unknown as { flush?: () => void }).flush?.();
      }
    } catch (err) {
      if ((err as Error)?.name !== "AbortError") throw err;
    } finally {
      res.end();
    }
  } catch (err) {
    // If streaming already started, the headers are sent — just end the socket.
    if (res.headersSent) {
      try { res.end(); } catch { /* already closed */ }
      return;
    }
    next(err);
  }
});
