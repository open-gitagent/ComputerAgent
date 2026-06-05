import { useEffect, useRef, useState } from "react";
import { Paperclip, Play, Send, RefreshCw, AlertCircle } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
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
  // status-only: `false` for terminal/info rows that should NOT show the
  // spinner (e.g. "Resumed — no stored transcript"). Omitted/true for
  // transient streaming statuses that get replaced on completion.
  loading?: boolean;
}

const CONTINUE_PROMPT =
  "Continue from where you left off — keep building until the project is complete, then summarize what you built and give me the deploy URL.";

export function ChatTab({
  agentId,
  agentName,
  sandboxCapable,
  resumeSessionId,
  onConsumedResume,
  initialMessage,
  onConsumedInitial,
  onSessionStarted,
}: {
  /** Registry ObjectId — used to address the agent in API calls. */
  agentId: string;
  /** Human name — used for display + the `bot` field on logged turns. */
  agentName: string;
  sandboxCapable: boolean;
  resumeSessionId: string | null;
  onConsumedResume: () => void;
  initialMessage?: string | null;
  onConsumedInitial?: () => void;
  /** Fired once a sandbox boots and a sessionId is established (new or resumed),
   *  so the parent can refresh / highlight the session list. */
  onSessionStarted?: (sessionId: string) => void;
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
  }, [agentId]);

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
        setMsgs(prior.length ? prior : [{ role: "status", text: "Resumed — no stored transcript. Continue below.", loading: false }]);
      } catch {
        setMsgs([{ role: "status", text: "Resumed session — memory is loaded. Continue below.", loading: false }]);
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
      // No `resume` → this is a fresh "New chat": force a brand-new session so
      // the server doesn't silently resume the agent's pinned (last) session.
      const r = await api.chatSandbox(agentId, resume ? { sessionId: resume } : { forceNew: true });
      setSandboxId(r.sandboxId);
      setSessionId(r.sessionId);
      // Only notify the parent for a genuinely NEW session — it adds the row to
      // the sidebar. Resuming an existing session must NOT fire this: the row
      // already exists and re-fetching the list on every click is the bug that
      // refetched sessions repeatedly.
      if (!resume) onSessionStarted?.(r.sessionId);
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
      streamUrl = api.runStreamUrl(agentId);
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
      bot: agentName,
      sessionId: sessionId ?? `oneshot-${agentName}`,
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
            Talk to {agentName}. It runs with its configured identity and tools.
          </div>
        )}
        {msgs.map((m, i) => {
          if (m.role === "status") {
            const isLoading = m.loading !== false;
            return (
              <div key={i} className="flex items-center gap-2 text-xs text-muted-foreground italic">
                {isLoading && <RefreshCw className="h-3 w-3 animate-spin" />}
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
            placeholder={`Message ${agentName}…  (Enter to send, Shift+Enter for newline)`}
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
  const isAssistant = msg.role === "assistant";
  return (
    <div className={cn("flex", isUser ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[80%] rounded-2xl px-4 py-2.5 text-sm break-words",
          // User input is verbatim (no markdown render); assistant uses
          // ReactMarkdown which handles its own whitespace.
          !isAssistant && "whitespace-pre-wrap",
          isUser ? "bg-primary text-primary-foreground" : "bg-muted text-foreground",
        )}
      >
        {isAssistant ? <Markdown text={msg.text} /> : msg.text}
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

/**
 * Chat-bubble Markdown renderer. Uses react-markdown + remark-gfm so the
 * assistant's output renders headings, lists, links, tables, and code blocks
 * properly instead of leaking raw `**bold**` / `# heading` syntax. Element
 * overrides keep the styling tight inside a constrained chat bubble.
 */
function Markdown({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        // Headings — compact in a bubble; reduce default sizes.
        h1: ({ children }) => <h1 className="text-base font-semibold mt-2 mb-1.5 first:mt-0">{children}</h1>,
        h2: ({ children }) => <h2 className="text-[15px] font-semibold mt-2 mb-1.5 first:mt-0">{children}</h2>,
        h3: ({ children }) => <h3 className="text-sm font-semibold mt-2 mb-1 first:mt-0">{children}</h3>,
        // Paragraphs + lists: tighter line-height than default prose for chat density.
        p: ({ children }) => <p className="leading-relaxed mb-2 last:mb-0">{children}</p>,
        ul: ({ children }) => <ul className="list-disc pl-5 space-y-0.5 mb-2 last:mb-0">{children}</ul>,
        ol: ({ children }) => <ol className="list-decimal pl-5 space-y-0.5 mb-2 last:mb-0">{children}</ol>,
        li: ({ children }) => <li className="leading-relaxed">{children}</li>,
        // Inline + block code. react-markdown emits <code> always; for fenced
        // blocks the parent is <pre>, so we check via inline prop (omitted in
        // v9+) — fall back on whether children contains a newline.
        code: ({ className, children, ...rest }) => {
          const text = String(children ?? "");
          const isBlock = /\n/.test(text) || /language-/.test(className ?? "");
          if (isBlock) {
            return (
              <pre className="bg-background/80 border border-border rounded-md p-2.5 my-2 overflow-x-auto text-xs">
                <code className={className} {...rest}>{children}</code>
              </pre>
            );
          }
          return (
            <code className="bg-background/60 px-1 py-0.5 rounded text-[0.85em] font-mono">{children}</code>
          );
        },
        // Hoist <pre> styles to the code-block path above; keep <pre> as-is
        // so nested <code> handles formatting.
        pre: ({ children }) => <>{children}</>,
        a: ({ href, children }) => (
          <a href={href} target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:opacity-80">
            {children}
          </a>
        ),
        blockquote: ({ children }) => (
          <blockquote className="border-l-2 border-border pl-3 my-2 text-muted-foreground italic">
            {children}
          </blockquote>
        ),
        table: ({ children }) => (
          <div className="my-2 overflow-x-auto">
            <table className="text-xs border-collapse">{children}</table>
          </div>
        ),
        th: ({ children }) => <th className="border border-border px-2 py-1 text-left font-semibold">{children}</th>,
        td: ({ children }) => <td className="border border-border px-2 py-1">{children}</td>,
        hr: () => <hr className="my-3 border-border" />,
        strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
        em: ({ children }) => <em className="italic">{children}</em>,
      }}
    >
      {text}
    </ReactMarkdown>
  );
}
