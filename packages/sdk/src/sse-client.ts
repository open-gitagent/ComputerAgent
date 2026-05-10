import type { HarnessEvent } from "@computeragent/protocol";

/**
 * Pure SSE byte-stream consumer.
 *
 * Reads a `ReadableStream<Uint8Array>` (the body of a fetch Response with
 * `Content-Type: text/event-stream`) and yields parsed `HarnessEvent`s.
 * Tolerant of partial chunks across reads.
 */
export async function* consumeSseEvents(
  body: ReadableStream<Uint8Array>,
): AsyncIterable<HarnessEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        if (buf.trim().length > 0) {
          for (const ev of parseBlocks(buf)) yield ev;
        }
        return;
      }
      buf += decoder.decode(value, { stream: true });
      let idx = buf.indexOf("\n\n");
      while (idx !== -1) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const ev of parseBlocks(block)) yield ev;
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

function parseBlocks(block: string): HarnessEvent[] {
  if (!block.trim()) return [];
  const dataLines: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
  }
  if (dataLines.length === 0) return [];
  try {
    const parsed = JSON.parse(dataLines.join("\n")) as HarnessEvent;
    if (parsed && typeof parsed === "object" && "kind" in parsed) return [parsed];
  } catch {
    /* malformed JSON — skip */
  }
  return [];
}
