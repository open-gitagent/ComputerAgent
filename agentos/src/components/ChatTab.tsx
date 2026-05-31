import { useEffect, useRef, useState } from "react";
import { Paperclip, Play, Send, RefreshCw, AlertCircle } from "lucide-react";
import { api } from "../api.ts";
import { streamChat, stripAttachMarkers } from "../sse.ts";
import { Button } from "./ui/button.tsx";
import { Textarea } from "./ui/textarea.tsx";
import { Badge } from "./ui/badge.tsx";
import { StatusDot } from "./composite/StatusDot.tsx";
import { cn } from "../lib/cn.ts";

interface Msg {
  role: "user" | "assistant" | "status";
  text: string;
  files?: string[];
  canContinue?: boolean;
}

const CONTINUE_PROMPT =
  "Continue from where you left off — keep building until the project is complete, then summarize what you built and give me the deploy URL.";

export function ChatTab({
  agent,
  sandboxCapable,
  resumeSessionId,
  onConsumedResume,
  initialMessage,
  onConsumedInitial,
}: {
  agent: string;
  sandboxCapable: boolean;
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

  useEffect(() => {
    setSandboxId(null);
    setSessionId(null);
    setMsgs([]);
    setErr(null);
  }, [agent]);

  useEffect(() => {
    if (!resumeSessionId) return;
    const sid = resumeSessionId;
    onConsumedResume();
    (async () => {
      try {
        const d = await api.session(sid);
        const prior: Msg[] = d.entries.map((e) => ({
          role: e.type.includes("user") ? "user" : "assistant",
          text: e.text,
        }));
        setMsgs(prior.length ? prior : [{ role: "status", text: "Resumed — no stored transcript. Continue below." }]);
      } catch {
        setMsgs([{ role: "status", text: "Resumed session — memory is loaded. Continue below." }]);
      }
      await boot(sid);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resumeSessionId]);

  useEffect(() => {
    if (!initialMessage) return;
    const m = initialMessage;
    onConsumedInitial?.();
    void send(m);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialMessage]);

  async function boot(resume?: string): Promise<string | null> {
    setBooting(true);
    setErr(null);
    try {
      const r = await api.chatSandbox(agent, resume);
      setSandboxId(r.sandboxId);
      setSessionId(r.sessionId);
      return r.sandboxId;
    } catch (e) {
      setErr(String(e));
      return null;
    } finally {
      setBooting(false);
    }
  }

  async function send(textArg?: string) {
    const text = (textArg ?? input).trim();
    if (!text || busy) return;

    let streamUrl: string;
    let curSandbox = sandboxId;
    if (sandboxCapable) {
      if (!curSandbox) {
        curSandbox = await boot();
        if (!curSandbox) return;
      }
      streamUrl = api.chatStreamUrl(curSandbox);
    } else {
      streamUrl = api.runStreamUrl(agent);
    }

    if (textArg === undefined) setInput("");
    setMsgs((m) => [...m, { role: "user", text }, { role: "status", text: "Working…" }]);
    setBusy(true);

    let finalText = "";
    let lastTools = 0;
    const setStatus = (s: string) =>
      setMsgs((m) => {
        const c = [...m];
        const last = c[c.length - 1];
        if (last?.role === "status") c[c.length - 1] = { role: "status", text: s };
        return c;
      });

    await streamChat(streamUrl, text, {
      onTool: (name, count) => {
        lastTools = count;
        setStatus(`${name}… (${count} tool${count !== 1 ? "s" : ""})`);
      },
      onText: (t) => {
        finalText = t;
      },
      onError: (msg) => setMsgs((m) => replaceStatus(m, { role: "assistant", text: `❌ ${msg}` })),
      onDone: (t) => {
        const raw = t || finalText;
        const { text: clean, files } = stripAttachMarkers(raw);
        const toolOnly = !clean && lastTools > 0;
        const body =
          clean ||
          (toolOnly
            ? `_(Ran ${lastTools} tool calls but stopped without a summary — likely its per-turn limit. Click Continue to keep building in this session.)_`
            : "_(no reply)_");
        setMsgs((m) =>
          replaceStatus(m, {
            role: "assistant",
            text: body,
            files: sandboxCapable && files.length ? files : undefined,
            canContinue: toolOnly,
          }),
        );
      },
    }).catch((e) => setMsgs((m) => replaceStatus(m, { role: "assistant", text: `❌ ${e}` })));

    setBusy(false);
    api.logWebTurn({
      bot: agent,
      sessionId: sessionId ?? `oneshot-${agent}`,
      query: text,
      reply: finalText,
      ok: true,
    }).catch(() => {});
  }

  return (
    <div className="h-full flex flex-col">
      {/* Session bar */}
      <div className="px-6 py-2.5 border-b border-border flex items-center gap-3 text-xs">
        {!sandboxCapable ? (
          <StatusDot status="idle" label="one-shot mode — each message is an independent run (no memory across turns)" />
        ) : sandboxId ? (
          <>
            <StatusDot status="live" />
            <span className="font-mono text-muted-foreground">{sessionId}</span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setSandboxId(null);
                setSessionId(null);
                setMsgs([]);
              }}
              className="ml-auto"
            >
              New session
            </Button>
          </>
        ) : (
          <span className="text-muted-foreground">{booting ? "Booting sandbox…" : "Send a message to start a session"}</span>
        )}
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
        {err && (
          <div className="flex items-start gap-2 text-sm text-destructive p-3 rounded-md bg-destructive/10 border border-destructive/20">
            <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
            <span>{err}</span>
          </div>
        )}
        {msgs.length === 0 && !err && (
          <div className="h-full grid place-items-center text-muted-foreground text-sm">
            Talk to {agent}. It runs with the same config as in Slack.
          </div>
        )}
        {msgs.map((m, i) => {
          if (m.role === "status") {
            return (
              <div key={i} className="flex items-center gap-2 text-xs text-muted-foreground italic">
                <RefreshCw className="h-3 w-3 animate-spin" />
                {m.text}
              </div>
            );
          }
          return <MessageBubble key={i} msg={m} sandboxId={sandboxId} busy={busy} onContinue={() => send(CONTINUE_PROMPT)} />;
        })}
      </div>

      {/* Input */}
      <div className="px-6 py-4 border-t border-border">
        <div className="flex gap-2">
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            placeholder={`Message ${agent}…  (Enter to send, Shift+Enter for newline)`}
            rows={2}
            className="flex-1 resize-none rounded-xl bg-card px-3.5 py-2.5"
          />
          <Button onClick={() => send()} disabled={busy || !input.trim()} className="rounded-xl px-4">
            {busy ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            <span>Send</span>
          </Button>
        </div>
      </div>
    </div>
  );
}

function MessageBubble({
  msg,
  sandboxId,
  busy,
  onContinue,
}: {
  msg: Msg;
  sandboxId: string | null;
  busy: boolean;
  onContinue: () => void;
}) {
  const isUser = msg.role === "user";
  return (
    <div className={cn("flex", isUser ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[80%] rounded-2xl px-4 py-2.5 text-sm whitespace-pre-wrap break-words",
          isUser ? "bg-primary text-primary-foreground" : "bg-muted text-foreground",
        )}
      >
        {msg.text}
        {msg.files && msg.files.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {msg.files.map((f) => (
              <a
                key={f}
                href={`/api/sandboxes/${encodeURIComponent(sandboxId ?? "")}/artifact?path=${encodeURIComponent(f)}`}
                target="_blank"
                rel="noreferrer"
                className="no-underline"
              >
                <Badge variant="outline" className="gap-1 hover:bg-muted">
                  <Paperclip className="h-3 w-3" />
                  {f.split("/").pop()}
                </Badge>
              </a>
            ))}
          </div>
        )}
        {msg.canContinue && !busy && (
          <Button variant="outline" size="sm" onClick={onContinue} className="mt-2">
            <Play className="h-3 w-3" />
            Continue building
          </Button>
        )}
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
