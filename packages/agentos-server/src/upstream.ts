// Loopback HTTP into the ComputerAgent harness server. Every call from the
// dashboard side that needs sandboxes / runs / live state goes through here.

import type { Response } from "express";
import { Readable } from "node:stream";
import { caAuthHeader } from "./auth.js";

export function caBase(): string {
  return (process.env["CA_BASE"] ?? "http://127.0.0.1:8787").replace(/\/+$/, "");
}

/** GET ${caBase}${path} as JSON. */
export async function caGetJson<T>(path: string): Promise<T> {
  const r = await fetch(`${caBase()}${path}`, { headers: caAuthHeader() });
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  return r.json() as Promise<T>;
}

export async function caPostJson<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`${caBase()}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...caAuthHeader() },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    const err = new Error(`${path} → ${r.status} ${text.slice(0, 300)}`);
    (err as any).status = r.status;
    throw err;
  }
  return r.json() as Promise<T>;
}

/**
 * Pipe an upstream fetch Response (SSE or binary) into an Express response.
 * Used by chat-sandbox SSE, one-shot /run SSE, and artifact download.
 */
export async function pipeUpstream(upstream: globalThis.Response, res: Response): Promise<void> {
  res.status(upstream.status);
  const ct = upstream.headers.get("content-type");
  if (ct) res.setHeader("content-type", ct);
  if (upstream.headers.get("cache-control")) {
    res.setHeader("cache-control", upstream.headers.get("cache-control")!);
  }
  if (!upstream.body) {
    res.end();
    return;
  }
  // Web ReadableStream → Node Readable → res. This handles SSE chunked
  // streaming and binary artifact payloads alike.
  const node = Readable.fromWeb(upstream.body as any);
  node.on("error", () => { try { res.end(); } catch { /* */ } });
  res.on("close", () => { try { node.destroy(); } catch { /* */ } });
  node.pipe(res);
}
