import { useMemo, useState } from "react";

export type Framework = "gitagent" | "claude-code" | "deep-agent" | "auto";

interface FrameworkDef {
  id: Framework;
  name: string;
  desc: string;
  glyph: string;
  // Backend agent name this maps to (null = not connected yet).
  agent: string | null;
}

const FRAMEWORKS: FrameworkDef[] = [
  { id: "gitagent", name: "GitAgent", desc: "Code-aware agent on gitclaw", glyph: "⌥", agent: "gitagent" },
  { id: "claude-code", name: "Claude Code", desc: "Anthropic code-native agent", glyph: "✳", agent: "claude-code" },
  { id: "deep-agent", name: "Deep Agent", desc: "LangGraph deep agent · one-shot", glyph: "❖", agent: "deep-agent" },
  { id: "auto", name: "Auto", desc: "Let AgentOS pick", glyph: "✨", agent: "gitagent" },
];

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
  const [note, setNote] = useState<string | null>(null);
  const { word, emoji } = useMemo(greeting, []);

  const selected = FRAMEWORKS.find((f) => f.id === framework)!;

  const submit = () => {
    const msg = prompt.trim();
    if (!msg) return;
    if (!selected.agent) {
      setNote(`${selected.name} isn't connected yet — only GitAgent is live. Pick GitAgent or Auto.`);
      return;
    }
    onLaunch(selected.agent, msg);
  };

  return (
    <div className="h-full overflow-y-auto bg-[#faf6ef] text-[#1c1a17]">
      {/* Brand */}
      <div className="flex items-center justify-end px-8 pt-7">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-xl bg-[#17150f] text-[#faf6ef] grid place-items-center text-lg">◇</div>
          <div className="leading-tight">
            <div className="font-semibold text-[17px]">AgentOS</div>
            <div className="text-[12px] italic text-[#8a8377]">where ideas become agents</div>
          </div>
        </div>
      </div>

      <div className="max-w-3xl mx-auto px-6 pb-20">
        {/* Greeting */}
        <div className="text-center mt-10 mb-2">
          <h1 className="font-serif text-5xl tracking-tight" style={{ fontFamily: "Georgia, 'Times New Roman', serif" }}>
            <span className="mr-3">{emoji}</span>{word}, Shreyas
          </h1>
          <p className="mt-4 text-lg text-[#6b6459]">What would you like to automate today?</p>
        </div>

        {/* Prompt box */}
        <div className="mt-8 rounded-3xl bg-white border border-[#e7e0d4] shadow-[0_2px_24px_rgba(0,0,0,0.04)] p-4">
          <div className="flex items-center gap-3 mb-2 relative">
            <button
              onClick={() => setPickerOpen((o) => !o)}
              className="inline-flex items-center gap-2 rounded-full border border-[#e3dccd] px-3.5 py-1.5 text-sm font-medium hover:bg-[#f7f3ea]"
            >
              <span className="text-[#a98b2f]">✦</span>
              {selected.name === "Auto" ? "Auto-select" : selected.name}
              <span className="text-[#b3aa9a]">▾</span>
            </button>
            <span className="text-sm text-[#9b9384]">framework · {framework === "auto" ? "pre-selected by Architect" : "manual"}</span>

            {pickerOpen && (
              <div className="absolute top-10 left-0 z-10 w-64 rounded-xl border border-[#e7e0d4] bg-white shadow-lg overflow-hidden">
                {FRAMEWORKS.map((f) => (
                  <button
                    key={f.id}
                    onClick={() => { setFramework(f.id); setPickerOpen(false); setNote(null); }}
                    className="w-full text-left px-4 py-2.5 hover:bg-[#f7f3ea] flex items-center gap-3"
                  >
                    <span className="h-7 w-7 grid place-items-center rounded-lg bg-[#17150f] text-[#faf6ef] text-sm">{f.glyph}</span>
                    <span>
                      <span className="block text-sm font-medium">{f.name}</span>
                      <span className="block text-[11px] text-[#9b9384]">{f.desc}</span>
                    </span>
                    {f.id === framework && <span className="ml-auto text-[#a98b2f]">✓</span>}
                  </button>
                ))}
              </div>
            )}
          </div>

          <textarea
            value={prompt}
            onChange={(e) => { setPrompt(e.target.value); setNote(null); }}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); } }}
            placeholder="Ask me anything — review a GitHub PR, research a topic and send a PDF, summarize a document, dig through a repo, or write a quick script."
            rows={5}
            className="w-full resize-none bg-transparent px-1 text-[17px] leading-relaxed placeholder:text-[#b9b1a2] focus:outline-none"
          />

          <div className="flex items-center mt-1">
            <button className="h-10 w-10 rounded-full bg-[#17150f] text-[#faf6ef] grid place-items-center text-xl" title="Attach (coming soon)">+</button>
            <div className="ml-auto flex items-center gap-2">
              <button className="h-10 w-10 rounded-full bg-[#17150f] text-[#faf6ef] grid place-items-center" title="Voice (coming soon)">🎤</button>
              <button
                onClick={submit}
                disabled={!prompt.trim()}
                className={`h-10 w-10 rounded-full grid place-items-center text-lg transition ${
                  prompt.trim() ? "bg-[#17150f] text-[#faf6ef] hover:opacity-90" : "bg-[#cfc7b8] text-white cursor-not-allowed"
                }`}
                title="Send"
              >↑</button>
            </div>
          </div>
        </div>

        {note && <div className="mt-3 text-sm text-[#b4502a]">{note}</div>}

        {/* Framework picker grid */}
        <div className="mt-10">
          <div className="flex items-center justify-between mb-3">
            <span className="text-[11px] tracking-[0.18em] text-[#9b9384] uppercase">Pick a framework</span>
            <button onClick={() => { setFramework("auto"); setNote(null); }} className="text-[12px] text-[#9b9384] hover:text-[#6b6459] font-mono">auto-select</button>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {FRAMEWORKS.map((f) => {
              const active = f.id === framework;
              return (
                <button
                  key={f.id}
                  onClick={() => { setFramework(f.id); setNote(null); }}
                  className={`text-left rounded-2xl border px-4 py-3.5 transition ${
                    active ? "border-[#17150f] bg-white shadow-sm" : "border-[#e7e0d4] bg-white/60 hover:bg-white"
                  }`}
                >
                  <div className="flex items-center gap-2.5">
                    <span className="h-8 w-8 grid place-items-center rounded-lg bg-[#17150f] text-[#faf6ef] text-sm">{f.glyph}</span>
                    <span className="font-semibold text-sm">{f.name}</span>
                    {active && <span className="ml-auto text-[#a98b2f]">✓</span>}
                  </div>
                  <div className="mt-1.5 text-[12px] text-[#9b9384] truncate">{f.desc}</div>
                  {!f.agent && <div className="mt-1 text-[10px] text-[#c08a3e]">not connected yet</div>}
                </button>
              );
            })}
          </div>
        </div>

        <div className="mt-12 text-center">
          <button onClick={onOpenDashboard} className="text-sm text-[#8a8377] hover:text-[#5b5448] underline underline-offset-4">
            Open control panel →
          </button>
        </div>
      </div>
    </div>
  );
}
