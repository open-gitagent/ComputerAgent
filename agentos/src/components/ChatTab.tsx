import { useEffect, useRef, useState } from "react";
import { api } from "../api.ts";
import { streamChat, stripAttachMarkers } from "../sse.ts";

interface Msg { role: "user" | "assistant" | "status"; text: string; files?: string[]; }

export function ChatTab({
  agent, resumeSessionId, onConsumedResume, initialMessage, onConsumedInitial,
}: {
  agent: string;
  resumeSessionId: string | null;
  onConsumedResume: () => void;
  initialMessage?: string | null;
  onConsumedInitial?: () => void;
}) {
  const [sandboxId, setSandboxId] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [booting, setBooting] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [msgs]);

  // Reset the console when the agent changes.
  useEffect(() => { setSandboxId(null); setSessionId(null); setMsgs([]); setErr(null); }, [agent]);

  // If asked to resume a session, boot a sandbox pinned to it.
  useEffect(() => {
    if (!resumeSessionId) return;
    boot(resumeSessionId);
    onConsumedResume();
  }, [resumeSessionId]);

  // From Home: auto-send the prompt the user typed on the landing page.
  useEffect(() => {
    if (!initialMessage) return;
    const m = initialMessage;
    onConsumedInitial?.();
    void send(m);
  }, [initialMessage]);

  async function boot(resume?: string): Promise<string | null> {
    setBooting(true); setErr(null);
    try {
      const r = await api.chatSandbox(agent, resume);
      setSandboxId(r.sandboxId);
      setSessionId(r.sessionId);
      if (resume) setMsgs([{ role: "status", text: `Resumed session ${resume} — its memory is loaded. Send a message to continue.` }]);
      return r.sandboxId;
    } catch (e) {
      setErr(String(e)); return null;
    } finally {
      setBooting(false);
    }
  }

  async function send(textArg?: string) {
    const text = (textArg ?? input).trim();
    if (!text || busy) return;
    let sid = sandboxId;
    if (!sid) { sid = await boot(); if (!sid) return; }

    if (textArg === undefined) setInput("");
    setMsgs((m) => [...m, { role: "user", text }, { role: "status", text: "🤔 Working…" }]);
    setBusy(true);

    let finalText = "";
    const setStatus = (s: string) => setMsgs((m) => {
      const c = [...m]; const last = c[c.length - 1];
      if (last?.role === "status") c[c.length - 1] = { role: "status", text: s };
      return c;
    });

    await streamChat(
      api.chatStreamUrl(sid),
      text,
      {
        onTool: (name, count) => setStatus(`🔧 ${name}… (${count} tool${count !== 1 ? "s" : ""})`),
        onText: (t) => { finalText = t; },
        onError: (msg) => setMsgs((m) => replaceStatus(m, { role: "assistant", text: `❌ ${msg}` })),
        onDone: (t) => {
          const { text: clean, files } = stripAttachMarkers(t || finalText || "_(no reply)_");
          setMsgs((m) => replaceStatus(m, { role: "assistant", text: clean, files: files.length ? files : undefined }));
        },
      },
    ).catch((e) => setMsgs((m) => replaceStatus(m, { role: "assistant", text: `❌ ${e}` })));

    setBusy(false);
    // Persist the web turn to the audit log.
    if (sessionId) api.logWebTurn({ bot: agent, sessionId, query: text, reply: finalText, ok: true }).catch(() => {});
  }

  return (
    <div className="h-full flex flex-col">
      <div className="px-6 py-2.5 border-b border-ink-700 flex items-center gap-3 text-xs text-gray-500">
        {sandboxId ? (
          <>
            <span className="h-2 w-2 rounded-full bg-emerald-400" />
            <span className="font-mono">{sessionId}</span>
            <button onClick={() => { setSandboxId(null); setSessionId(null); setMsgs([]); }}
              className="ml-auto px-2 py-1 rounded bg-ink-700 hover:bg-ink-600">New session</button>
          </>
        ) : (
          <span>{booting ? "Booting sandbox…" : "Send a message to start a session"}</span>
        )}
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
        {err && <div className="text-red-400 text-sm">{err}</div>}
        {msgs.length === 0 && !err && (
          <div className="h-full grid place-items-center text-gray-600 text-sm">
            Talk to {agent}. It runs with the same config as in Slack.
          </div>
        )}
        {msgs.map((m, i) => {
          if (m.role === "status") return <div key={i} className="text-xs text-gray-500 italic">{m.text}</div>;
          const isUser = m.role === "user";
          return (
            <div key={i} className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
              <div className={`max-w-[80%] rounded-2xl px-4 py-2.5 text-sm whitespace-pre-wrap break-words ${
                isUser ? "bg-accent/90 text-white" : "bg-ink-700 text-gray-200"
              }`}>
                {m.text}
                {m.files && m.files.length > 0 && (
                  <div className="mt-2 flex flex-col gap-1">
                    {m.files.map((f) => (
                      <a key={f} href={`/api/sandboxes/${encodeURIComponent(sandboxId ?? "")}/artifact?path=${encodeURIComponent(f)}`}
                        target="_blank" rel="noreferrer"
                        className="text-xs underline text-indigo-300 hover:text-indigo-200">📎 {f.split("/").pop()}</a>
                    ))}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="px-6 py-4 border-t border-ink-700">
        <div className="flex gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
            placeholder={`Message ${agent}…  (Enter to send, Shift+Enter for newline)`}
            rows={2}
            className="flex-1 resize-none rounded-xl bg-ink-800 border border-ink-600 px-3.5 py-2.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent"
          />
          <button
            onClick={() => send()}
            disabled={busy || !input.trim()}
            className="px-4 rounded-xl bg-accent hover:bg-accent-soft disabled:opacity-40 text-white text-sm font-medium"
          >
            {busy ? "…" : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}

function replaceStatus(m: Msg[], replacement: Msg): Msg[] {
  const c = [...m];
  if (c[c.length - 1]?.role === "status") c[c.length - 1] = replacement;
  else c.push(replacement);
  return c;
}
