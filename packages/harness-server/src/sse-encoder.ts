import type { HarnessEvent } from "@open-gitagent/protocol";

/**
 * Pure SSE serialization. No I/O. Returns the wire-format string for one event.
 *
 * The full SSE spec is broader, but the Harness Protocol uses only:
 *   event: <kind>
 *   id: <monotonic>
 *   data: <json>
 *   <blank line>
 */
export function encodeSseEvent(event: HarnessEvent, id: number): string {
  const json = JSON.stringify(event);
  return `event: ${event.kind}\nid: ${id}\ndata: ${json}\n\n`;
}
