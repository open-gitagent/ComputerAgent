import type { HarnessEvent } from "@open-gitagent/protocol";

/**
 * Parse a chunk of an SSE response body into typed events. Tolerates partial
 * chunks: returns parsed events plus a `remainder` you concat onto the next chunk.
 */
export interface ParsedSse {
  readonly events: ReadonlyArray<{ kind: string; id?: string; data: unknown }>;
  readonly remainder: string;
}

/**
 * Pure SSE chunk parser — tests use this to assert the event sequence on a stream
 * without bringing in a real EventSource.
 */
export function parseSseChunk(buf: string): ParsedSse {
  const events: { kind: string; id?: string; data: unknown }[] = [];
  const blocks = buf.split("\n\n");
  // Last block may be incomplete; hold it as remainder.
  const remainder = blocks.length > 0 ? (blocks.pop() ?? "") : "";

  for (const block of blocks) {
    if (!block.trim()) continue;
    let kind = "message";
    let id: string | undefined;
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) kind = line.slice(6).trim();
      else if (line.startsWith("id:")) id = line.slice(3).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }
    if (dataLines.length === 0) continue;
    let data: unknown;
    try {
      data = JSON.parse(dataLines.join("\n"));
    } catch {
      data = dataLines.join("\n");
    }
    events.push(id !== undefined ? { kind, id, data } : { kind, data });
  }
  return { events, remainder };
}

/**
 * Drain an SSE Response body into typed `HarnessEvent`s. Use in tests with the
 * fetch-style Response from supertest or Hono's `app.request()`.
 */
export async function collectSseEvents(body: ReadableStream<Uint8Array>, max = 50): Promise<HarnessEvent[]> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  const out: HarnessEvent[] = [];
  let buf = "";
  while (out.length < max) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const { events, remainder } = parseSseChunk(buf);
    buf = remainder;
    for (const e of events) {
      const data = e.data as Record<string, unknown>;
      if (data && typeof data === "object" && "kind" in data) {
        out.push(data as unknown as HarnessEvent);
        if ((data as { kind?: string }).kind === "ca_session_ended") return out;
      }
    }
  }
  return out;
}
