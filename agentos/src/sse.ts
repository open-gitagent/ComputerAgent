// SSE chat streaming + multi-dialect event parser, ported from test.html.
// Handles claude-agent-sdk (nested), gitagent (flat), and deepagents (LangGraph)
// payload shapes. Surfaces tool-call progress + the final assistant text.

export interface ChatStreamHandlers {
  onTool?: (name: string, count: number) => void;
  onText?: (finalText: string) => void;      // latest known final text (may update)
  onError?: (msg: string) => void;
  onDone?: (finalText: string) => void;
}

const ATTACH_RE = /\[\[ATTACH:([^\]]+)\]\]/g;

export function stripAttachMarkers(s: string): { text: string; files: string[] } {
  const files: string[] = [];
  const text = s.replace(ATTACH_RE, (_m, p) => { files.push(String(p).trim()); return ""; })
    .replace(/\n{3,}/g, "\n\n").trim();
  return { text: text || s, files };
}

export async function streamChat(
  url: string,
  message: string,
  handlers: ChatStreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify({ message }),
    signal,
  });
  if (res.status === 409) { handlers.onError?.("Agent is busy with another turn in this session."); return; }
  if (!res.ok || !res.body) {
    const t = await res.text().catch(() => "");
    handlers.onError?.(`Chat failed (${res.status}): ${t.slice(0, 300)}`);
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buf = "";
  let finalText = "";
  let toolCount = 0;
  let daMsgCount = 0;

  const setFinal = (t: string) => { finalText = t; handlers.onText?.(t); };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
      let ev = ""; let data: any = null;
      for (const line of frame.split("\n")) {
        if (line.startsWith("event: ")) ev = line.slice(7);
        else if (line.startsWith("data: ")) { try { data = JSON.parse(line.slice(6)); } catch { /* skip */ } }
      }
      if (!ev || !data) continue;

      if (ev === "sdk_message" && typeof data === "object") {
        const p = data.payload ?? {};
        // claude-agent-sdk
        if (p.type === "assistant" && typeof p.message === "object" && p.message) {
          for (const b of (p.message.content ?? [])) {
            if (b?.type === "tool_use") { toolCount++; handlers.onTool?.(b.name ?? "tool", toolCount); }
            else if (b?.type === "text" && typeof b.text === "string") setFinal(b.text);
          }
        }
        // gitagent flat
        else if (p.type === "tool_use") { toolCount++; handlers.onTool?.((p.toolName ?? p.name ?? "tool"), toolCount); }
        else if (p.type === "assistant" && typeof p.content === "string") setFinal(p.content);
        else if (p.type === "result" && typeof p.result === "string") setFinal(p.result);
        // deepagents
        else if (Array.isArray(p.messages)) {
          const newOnes = p.messages.slice(daMsgCount);
          daMsgCount = p.messages.length;
          for (const m of newOnes) {
            const k = (m.kwargs ?? m) as any;
            const cls = (m.id ?? []).join(".");
            if (Array.isArray(k.tool_calls)) for (const tc of k.tool_calls) { toolCount++; handlers.onTool?.(tc.name ?? "tool", toolCount); }
            if (cls.includes("AIMessage") && typeof k.content === "string" && k.content.trim()) setFinal(k.content);
          }
        }
      } else if (ev === "ca_error") {
        handlers.onError?.(data.message ?? "Unknown error");
        return;
      } else if (ev === "ca_session_ended" || ev === "ca_done") {
        // ca_done is the server's terminal marker; ca_session_ended ends the turn.
        if (ev === "ca_session_ended") break;
      }
    }
  }
  handlers.onDone?.(finalText);
}
