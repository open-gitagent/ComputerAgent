import type { HarnessEvent } from "@open-gitagent/protocol";

/** A wire envelope: the SSE `id:` field (if present) and the parsed event. */
export interface SseEnvelope {
  readonly id?: number;
  readonly event: HarnessEvent;
}

/**
 * Pure SSE byte-stream consumer.
 *
 * Reads a `ReadableStream<Uint8Array>` (the body of a fetch Response with
 * `Content-Type: text/event-stream`) and yields `{ id?, event }` envelopes.
 * Tolerant of partial chunks across reads.
 *
 * The `id` lets callers track the highest-seen event id and resume on
 * reconnect via `Last-Event-ID`.
 */
export async function* consumeSseEvents(
  body: ReadableStream<Uint8Array>,
): AsyncIterable<SseEnvelope> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        if (buf.trim().length > 0) {
          for (const env of parseBlocks(buf)) yield env;
        }
        return;
      }
      buf += decoder.decode(value, { stream: true });
      let idx = buf.indexOf("\n\n");
      while (idx !== -1) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const env of parseBlocks(block)) yield env;
        idx = buf.indexOf("\n\n");
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }
}

function parseBlocks(block: string): SseEnvelope[] {
  if (!block.trim()) return [];
  const dataLines: string[] = [];
  let id: number | undefined;
  for (const line of block.split("\n")) {
    if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    else if (line.startsWith("id:")) {
      const n = Number.parseInt(line.slice(3).trim(), 10);
      if (Number.isFinite(n)) id = n;
    }
  }
  if (dataLines.length === 0) return [];
  try {
    const parsed = JSON.parse(dataLines.join("\n")) as HarnessEvent;
    if (parsed && typeof parsed === "object" && "kind" in parsed) {
      return [{ id, event: parsed }];
    }
  } catch {
    /* malformed JSON — skip */
  }
  return [];
}
