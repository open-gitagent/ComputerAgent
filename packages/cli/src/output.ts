import type { HarnessEvent } from "@open-gitagent/sdk";

/**
 * Render a HarnessEvent as a single line of human-readable output.
 *
 * Returns null if the event is too noisy to print (e.g. raw stream_event deltas).
 * Pure — no I/O, no color (CLI consumer decides).
 */
export function renderEventLine(ev: HarnessEvent): string | null {
  switch (ev.kind) {
    case "ca_session_started":
      return `▶ session ${ev.sessionId}  engine=${ev.engine}  identity=${ev.identity.name}@${ev.identity.version}`;
    case "ca_session_ended":
      return `■ ended  reason=${ev.reason}${ev.errorMessage ? `  error=${ev.errorMessage}` : ""}`;
    case "ca_permission_request":
      return `? permission  callId=${ev.callId}  tool=${ev.toolName}`;
    case "ca_permission_decision":
      return `✓ permission  callId=${ev.callId}  decision=${ev.decision}`;
    case "ca_turn_started":
      return `▸ turn ${ev.turnIndex}`;
    case "ca_usage_snapshot": {
      const cost = ev.costUsd !== undefined ? `$${ev.costUsd.toFixed(4)}` : "";
      const tokens =
        ev.inputTokens !== undefined && ev.outputTokens !== undefined
          ? `${ev.inputTokens}in/${ev.outputTokens}out`
          : "";
      return `… usage  ${tokens}  ${cost}`.replace(/\s+/g, " ").trim();
    }
    case "sdk_message":
      return renderSdkMessage(ev.payload);
  }
}

function renderSdkMessage(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as { type?: string; subtype?: string; result?: string; message?: { content?: unknown } };
  if (p.type === "result" && typeof p.result === "string") {
    return `← result  ${truncate(p.result, 200)}`;
  }
  if (p.type === "system" && p.subtype) {
    return `· system  ${p.subtype}`;
  }
  if (p.type === "assistant" && p.message?.content) {
    const text = extractText(p.message.content);
    return text ? `· assistant  ${truncate(text, 200)}` : null;
  }
  if (p.type === "stream_event") return null; // too chatty for the line view
  return null;
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        const block = b as { type?: string; text?: string };
        return block.type === "text" && typeof block.text === "string" ? block.text : "";
      })
      .filter(Boolean)
      .join(" ");
  }
  return "";
}

function truncate(s: string, max: number): string {
  const single = s.replace(/\s+/g, " ").trim();
  return single.length > max ? `${single.slice(0, max - 1)}…` : single;
}
