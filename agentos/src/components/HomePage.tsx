import { useMemo, useState } from "react";
import { Sparkles, ArrowUp, Plus, Mic, Check } from "lucide-react";
import { toast } from "sonner";
import { Button } from "./ui/button.tsx";
import { Textarea } from "./ui/textarea.tsx";
import { Card } from "./ui/card.tsx";
import { Badge } from "./ui/badge.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover.tsx";
import { cn } from "../lib/cn.ts";

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

function greeting(): { word: string; emoji: string } {
  const h = new Date().getHours();
  if (h < 12) return { word: "Good morning", emoji: "☀️" };
  if (h < 17) return { word: "Good afternoon", emoji: "🌤️" };
  return { word: "Good evening", emoji: "🌙" };
}

export function HomePage({
  onLaunch,
  onOpenDashboard,
}: {
  onLaunch: (agent: string, message: string) => void;
  onOpenDashboard: () => void;
}) {
  const [framework, setFramework] = useState<Framework>("auto");
  const [prompt, setPrompt] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const { word, emoji } = useMemo(greeting, []);

  const selected = FRAMEWORKS.find((f) => f.id === framework)!;

  const submit = () => {
    const msg = prompt.trim();
    if (!msg) return;
    if (!selected.agent) {
      toast.error(`${selected.name} isn't connected yet`, {
        description: "Only GitAgent is live. Pick GitAgent or Auto.",
      });
      return;
    }
    onLaunch(selected.agent, msg);
  };

  return (
    <div className="h-full overflow-y-auto bg-background text-foreground">
      {/* Brand */}
      <div className="flex items-center justify-end px-8 pt-7">
        <div className="flex items-center gap-3">
          <img src="/logos/agentos.png" alt="ComputerAgent" className="h-11 w-11 rounded-xl object-contain" />
          <div className="leading-tight text-right">
            <div className="font-semibold text-[15px] tracking-tight">ComputerAgent Console</div>
            <div className="text-[12px] italic text-muted-foreground">where ideas become agents</div>
          </div>
        </div>
      </div>

      <div className="max-w-3xl mx-auto px-6 pb-20">
        {/* Hero — the retro CRT in the field */}
        <div className="mt-6 relative rounded-2xl overflow-hidden border border-border h-52">
          <img src="/logos/hero.jpg" alt="ComputerAgent" className="w-full h-full object-cover object-center" />
          <div className="absolute inset-0 bg-gradient-to-t from-background via-background/30 to-transparent" />
          <div className="absolute bottom-3 left-4 right-4 flex items-end justify-between">
            <span className="text-[11px] uppercase tracking-[0.2em] text-sand/80">
              ComputerAgent · Research Labs
            </span>
            <span className="h-2 w-2 rounded-full bg-primary shadow-[0_0_10px_hsl(var(--primary))]" />
          </div>
        </div>

        {/* Greeting */}
        <div className="text-center mt-8 mb-2">
          <h1
            className="text-5xl tracking-tight"
            style={{ fontFamily: "Georgia, 'Times New Roman', serif" }}
          >
            <span className="mr-3">{emoji}</span>
            {word}, Shreyas
          </h1>
          <p className="mt-4 text-base text-muted-foreground">What would you like to automate today?</p>
        </div>

        {/* Prompt box */}
        <Card className="mt-8 p-4 shadow-[0_8px_40px_rgba(0,0,0,0.35)] rounded-2xl">
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
            placeholder="Ask me anything — review a GitHub PR, research a topic and send a PDF, summarize a document, dig through a repo, or write a quick script."
            rows={5}
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
                disabled={!prompt.trim()}
                size="icon"
                className="rounded-full h-10 w-10"
                title="Send (Cmd+Enter)"
              >
                <ArrowUp className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </Card>

        {/* Framework picker grid */}
        <div className="mt-10">
          <div className="flex items-center justify-between mb-3">
            <span className="text-[11px] tracking-[0.18em] text-muted-foreground uppercase">Pick a framework</span>
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
            Open control panel →
          </button>
        </div>
      </div>
    </div>
  );
}
