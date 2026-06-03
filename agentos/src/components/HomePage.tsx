import { useEffect, useState } from "react";
import { Sparkles, ArrowUp, Plus, Mic, Check } from "lucide-react";
import { toast } from "sonner";
import { Button } from "./ui/button.tsx";
import { Textarea } from "./ui/textarea.tsx";
import { Card } from "./ui/card.tsx";
import { Badge } from "./ui/badge.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover.tsx";
import { api, type Agent } from "../api.ts";
import { streamChat, streamCompletion } from "../sse.ts";
import { cn } from "../lib/cn.ts";

interface ChatTurn {
  role: "user" | "assistant";
  text: string;
}

export type Framework = "gitagent" | "claude-code" | "deep-agent" | "auto";

interface FrameworkDef {
  id: Framework;
  name: string;
  desc: string;
  logo?: string;
  agent: string | null;
}

const FRAMEWORKS: FrameworkDef[] = [
  { id: "gitagent",    name: "GitAgent",    desc: "Code-aware agent on gitclaw",        logo: "/logos/gitagent.png",   agent: "gitagent" },
  { id: "claude-code", name: "Claude Code", desc: "Anthropic code-native agent",        logo: "/logos/claude.svg",     agent: "claude-code" },
  { id: "deep-agent",  name: "Deep Agent",  desc: "LangGraph deep agent · one-shot",    logo: "/logos/langchain.svg",  agent: "deep-agent" },
  { id: "auto",        name: "Auto",        desc: "Let AgentOS pick",                    logo: "/logos/auto.svg",       agent: "gitagent" },
];

function FrameworkIcon({ f, size = 32 }: { f: FrameworkDef; size?: number }) {
  return (
    <span
      className="grid place-items-center rounded-md bg-white shrink-0 overflow-hidden"
      style={{ height: size, width: size }}
    >
      {f.logo && (
        <img
          src={f.logo}
          alt={f.name}
          className="object-contain"
          style={{ height: size * 0.62, width: size * 0.62 }}
        />
      )}
    </span>
  );
}

function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}

export function HomePage({
  onLaunch,
  onOpenDashboard,
  agents,
}: {
  onLaunch: (agent: string, message: string) => void;
  onOpenDashboard: () => void;
  agents: Agent[];
}) {
  const [framework, setFramework] = useState<Framework>("auto");
  const [prompt, setPrompt] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [messages, setMessages] = useState<ChatTurn[]>([]);
  const [busy, setBusy] = useState(false);
  // Warm sandbox for the home chat — created on first turn, reused after so the
  // agent keeps conversation memory across turns (same as the dashboard chat).
  const [sandboxId, setSandboxId] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  // Greeting follows the user's local browser time and refreshes each minute so
  // it stays correct if the page is left open across a morning/afternoon/evening
  // boundary.
  const [word, setWord] = useState(greeting);
  useEffect(() => {
    const id = setInterval(() => setWord(greeting()), 60_000);
    return () => clearInterval(id);
  }, []);

  const selected = FRAMEWORKS.find((f) => f.id === framework)!;

  // Switching the agent runtime starts a fresh sandbox on the next turn.
  useEffect(() => {
    setSandboxId(null);
    setSessionId(null);
  }, [framework]);

  // Explicit framework → its mapped agent. sandboxCapable comes from the
  // registry when the agent is known, else inferred (deepagents run one-shot).
  const resolveTarget = (): { name: string; sandboxCapable: boolean } => {
    const name = selected.agent ?? agents[0]?.name ?? "gitagent";
    const found = agents.find((a) => a.name === name);
    return { name, sandboxCapable: found ? found.sandboxCapable : selected.id !== "deep-agent" };
  };

  const submit = async () => {
    const msg = prompt.trim();
    if (!msg || busy) return;
    setPrompt("");
    const history: ChatTurn[] = [...messages, { role: "user", text: msg }];
    const assistantIdx = history.length;
    setMessages([...history, { role: "assistant", text: "" }]);
    setBusy(true);

    const setAssistant = (text: string) =>
      setMessages((cur) => {
        const next = [...cur];
        if (next[assistantIdx]) next[assistantIdx] = { role: "assistant", text };
        return next;
      });

    // Auto → agent-less Claude completion (direct /api/completion proxy). No
    // sandbox, no specific bot — predictable plain Claude chat. The explicit
    // runtime picks below run as real agents through the harness instead.
    if (framework === "auto") {
      try {
        await streamCompletion(
          history.map((m) => ({ role: m.role, content: m.text })),
          { onText: setAssistant, onError: (e) => setAssistant(`⚠️ ${e}`), onDone: () => {} },
        );
      } catch (e) {
        setAssistant(`⚠️ ${String(e)}`);
      } finally {
        setBusy(false);
      }
      return;
    }

    // Explicit runtime → run as a REAL agent through the ComputerAgent server:
    // boot/reuse a harness sandbox (or one-shot /run for deepagents) and stream.
    try {
      const target = resolveTarget();
      let streamUrl: string;
      let turnSession = sessionId;

      if (target.sandboxCapable) {
        let sb = sandboxId;
        if (!sb) {
          const created = await api.chatSandbox(target.name);
          sb = created.sandboxId;
          turnSession = created.sessionId;
          setSandboxId(created.sandboxId);
          setSessionId(created.sessionId);
        }
        streamUrl = api.chatStreamUrl(sb);
      } else {
        // One-shot agents (deepagents): no warm sandbox, no cross-turn memory.
        streamUrl = api.runStreamUrl(target.name);
      }

      await streamChat(streamUrl, msg, {
        onText: setAssistant,
        onError: (e) => setAssistant(`⚠️ ${e}`),
        onDone: (final) => {
          if (turnSession && final) {
            api
              .logWebTurn({ bot: target.name, sessionId: turnSession, query: msg, reply: final, ok: true })
              .catch(() => {});
          }
        },
      });
    } catch (e) {
      setAssistant(`⚠️ ${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  // The prompt composer — reused in the landing hero and pinned to the bottom
  // of the chat window once a conversation starts.
  const promptCard = (rows: number) => (
    <Card className="p-4 shadow-[0_8px_40px_rgba(0,0,0,0.35)] rounded-2xl">
      <div className="flex items-center gap-3 mb-2">
        <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm" className="rounded-full">
              <Sparkles className="h-3.5 w-3.5 text-primary" />
              {selected.name === "Auto" ? "Auto-select" : selected.name}
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-72 p-1.5">
            <div className="space-y-0.5">
              {FRAMEWORKS.map((f) => (
                <button
                  key={f.id}
                  onClick={() => {
                    setFramework(f.id);
                    setPickerOpen(false);
                  }}
                  className={cn(
                    "w-full text-left rounded-md px-2 py-2 hover:bg-accent transition-colors flex items-center gap-2.5",
                    f.id === framework && "bg-accent",
                  )}
                >
                  <FrameworkIcon f={f} size={28} />
                  <span className="flex-1 min-w-0">
                    <span className="block text-sm font-medium truncate">{f.name}</span>
                    <span className="block text-[11px] text-muted-foreground truncate">{f.desc}</span>
                  </span>
                  {f.id === framework && <Check className="h-3.5 w-3.5 text-primary shrink-0" />}
                </button>
              ))}
            </div>
          </PopoverContent>
        </Popover>
      </div>

      <Textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            submit();
          }
        }}
        placeholder="Delegate a task — review a pull request, audit a repository, research a market, draft a report, or run a custom workflow."
        rows={rows}
        className="border-0 px-1 text-[16px] leading-relaxed bg-transparent focus-visible:ring-0 focus-visible:ring-offset-0 resize-none"
      />

      <div className="flex items-center mt-1">
        <Button variant="ghost" size="icon" className="rounded-full h-10 w-10" title="Attach (coming soon)" disabled>
          <Plus className="h-4 w-4" />
        </Button>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="ghost" size="icon" className="rounded-full h-10 w-10" title="Voice (coming soon)" disabled>
            <Mic className="h-4 w-4" />
          </Button>
          <Button
            onClick={submit}
            disabled={!prompt.trim() || busy}
            size="icon"
            className="rounded-full h-10 w-10"
            title="Send (Cmd+Enter)"
          >
            <ArrowUp className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </Card>
  );

  const thread = (
    <div className="space-y-3">
      {messages.map((m, i) => (
        <div key={i} className={cn("flex", m.role === "user" ? "justify-end" : "justify-start")}>
          <div
            className={cn(
              "max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap break-words",
              m.role === "user" ? "bg-primary text-primary-foreground" : "bg-muted text-foreground",
            )}
          >
            {m.text || (busy && m.role === "assistant" ? "…" : "")}
          </div>
        </div>
      ))}
    </div>
  );

  // Chat window — replaces the landing once a conversation starts.
  if (messages.length > 0) {
    return (
      <div className="h-full flex flex-col bg-background text-foreground">
        <div className="flex items-center justify-between px-6 py-3 border-b border-border shrink-0">
          <div className="flex items-center gap-2.5">
            <img src="/logos/agentos.png" alt="ComputerAgent" className="h-7 w-7 rounded-md object-contain" />
            <div className="leading-tight">
              <div className="text-sm font-semibold tracking-tight">ComputerAgent</div>
              <div className="text-[11px] text-muted-foreground">Quick chat</div>
            </div>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setMessages([]);
              setPrompt("");
              setSandboxId(null);
              setSessionId(null);
            }}
          >
            <Plus className="h-3.5 w-3.5" />
            New chat
          </Button>
        </div>

        <div className="flex-1 overflow-y-auto">
          <div className="max-w-3xl mx-auto px-6 py-6">{thread}</div>
        </div>

        <div className="border-t border-border shrink-0 bg-background">
          <div className="max-w-3xl mx-auto px-6 py-4">{promptCard(3)}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto bg-background text-foreground">
      {/* Brand */}
      <div className="flex items-center justify-between px-8 pt-7">
        <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.6)]" />
          Operational
        </div>
        <div className="flex items-center gap-3">
          <img src="/logos/agentos.png" alt="ComputerAgent" className="h-11 w-11 rounded-xl object-contain" />
          <div className="leading-tight text-right">
            <div className="font-semibold text-[15px] tracking-tight">ComputerAgent Console</div>
            <div className="text-[12px] text-muted-foreground">Enterprise agent operations</div>
          </div>
        </div>
      </div>

      <div className="max-w-3xl mx-auto px-6 pb-20">
        {/* Greeting */}
        <div className="text-center mt-16 mb-2">
          <h1
            className="text-5xl tracking-tight"
            style={{ fontFamily: "Georgia, 'Times New Roman', serif" }}
          >
            {word}
          </h1>
          <p className="mt-4 text-base text-muted-foreground">Describe the task. Your agents will handle it.</p>
        </div>

        {/* Prompt box */}
        <div className="mt-8">{promptCard(5)}</div>

        {/* Framework picker grid */}
        <div className="mt-10">
          <div className="flex items-center justify-between mb-3">
            <span className="text-[11px] tracking-[0.18em] text-muted-foreground uppercase">Agent runtime</span>
            <button
              onClick={() => setFramework("auto")}
              className="text-[12px] text-muted-foreground hover:text-foreground font-mono transition-colors"
            >
              auto-select
            </button>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {FRAMEWORKS.map((f) => {
              const active = f.id === framework;
              return (
                <button
                  key={f.id}
                  onClick={() => setFramework(f.id)}
                  className={cn(
                    "text-left rounded-xl border px-4 py-3.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    active
                      ? "border-primary bg-muted"
                      : "border-border bg-card hover:bg-muted/60",
                  )}
                >
                  <div className="flex items-center gap-2.5">
                    <FrameworkIcon f={f} size={32} />
                    <span className="font-semibold text-sm flex-1">{f.name}</span>
                    {active && <Check className="h-3.5 w-3.5 text-primary shrink-0" />}
                  </div>
                  <div className="mt-1.5 text-[12px] text-muted-foreground truncate">{f.desc}</div>
                  {!f.agent && (
                    <Badge variant="warning" className="mt-1.5 text-[9px]">
                      not connected yet
                    </Badge>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        <div className="mt-12 text-center">
          <button
            onClick={onOpenDashboard}
            className="text-sm text-muted-foreground hover:text-foreground underline underline-offset-4 transition-colors"
          >
            Open operations dashboard →
          </button>
        </div>
      </div>
    </div>
  );
}
