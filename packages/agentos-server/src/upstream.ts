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
 * DELETE ${caBase}${path}. Tolerates 404 (already gone) — returns the parsed
 * JSON body, or `{}` when the upstream sends none. Throws on other non-2xx so
 * callers can surface real failures (e.g. as a cleanup warning).
 */
export async function caDelete<T = unknown>(path: string): Promise<T> {
  const r = await fetch(`${caBase()}${path}`, { method: "DELETE", headers: caAuthHeader() });
  if (!r.ok && r.status !== 404) {
    const text = await r.text().catch(() => "");
    const err = new Error(`DELETE ${path} → ${r.status} ${text.slice(0, 300)}`);
    (err as any).status = r.status;
    throw err;
  }
  return (await r.json().catch(() => ({}))) as T;
}

export interface LiveSandboxItem {
  sandboxId: string;
  sessionId: string;
  state: string;
}

/**
 * List the harness's live sandboxes. Best-effort with a 2s timeout so a slow
 * or unreachable harness never blocks the dashboard — an empty array means
 * "no live info available", which callers treat as "nothing is warm".
 */
export async function listLiveSandboxes(): Promise<LiveSandboxItem[]> {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 2_000);
    const r = await fetch(`${caBase()}/sandboxes`, { headers: caAuthHeader(), signal: ctl.signal })
      .finally(() => clearTimeout(timer));
    if (!r.ok) return [];
    const j = (await r.json()) as { sandboxes?: LiveSandboxItem[] };
    return j.sandboxes ?? [];
  } catch {
    return [];
  }
}

/**
 * Map of sessionId → true for sessions that have a genuinely warm sandbox
 * (state is neither "expired" nor "disposed"). This is the authoritative
 * warmth signal — derived from the harness registry, not from any stored flag.
 */
export async function warmSessions(): Promise<Set<string>> {
  const live = await listLiveSandboxes();
  const warm = new Set<string>();
  for (const sb of live) {
    if (sb.state !== "expired" && sb.state !== "disposed") warm.add(sb.sessionId);
  }
  return warm;
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
