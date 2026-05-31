/**
 * Full-fledged marketing agent example.
 *
 * Runs the example marketing-agent GAP repo (github.com/open-gitagent/example-marketing-agent)
 * as a multi-turn session: first turn sets product context, subsequent turns
 * request specific marketing deliverables. Each response streams in real-time
 * and the final outputs are saved to markdown files under ./marketing-outputs/.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-ant-... bun run examples/marketing-agent.ts
 *
 * On subsequent runs, the session is resumed from disk so the agent remembers
 * the product context set in the first turn.
 *
 *   ANTHROPIC_API_KEY=sk-ant-... bun run examples/marketing-agent.ts resume
 *
 * What this demonstrates:
 *   - Running a real public GAP repo via ComputerAgent
 *   - Streaming every sdk_message and tool call as they arrive
 *   - Multi-turn conversation with a file-backed SessionStore
 *   - Fetching agent-produced files via the Harness FS API
 *   - clean dispose() via `await using`
 */

import { mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ComputerAgent, LocalSubstrate } from "computeragent";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) {
  console.error("Error: ANTHROPIC_API_KEY is not set.");
  console.error("  export ANTHROPIC_API_KEY=sk-ant-...");
  process.exit(1);
}

const OUTPUTS_DIR = join(import.meta.dir ?? __dirname, "marketing-outputs");
const SESSION_FILE = join(OUTPUTS_DIR, ".session-id");
const RESUME = process.argv[2] === "resume";

// ── Helpers ──────────────────────────────────────────────────────────────────

function hr(label: string): void {
  const line = "─".repeat(60);
  console.log(`\n${line}`);
  console.log(`  ${label}`);
  console.log(`${line}`);
}

function dim(s: string): string {
  return `\x1b[2m${s}\x1b[0m`;
}

function green(s: string): string {
  return `\x1b[32m${s}\x1b[0m`;
}

function yellow(s: string): string {
  return `\x1b[33m${s}\x1b[0m`;
}

async function streamTurn(
  agent: ComputerAgent,
  message: string,
): Promise<{ sessionId: string; result: string; harnessUrl: string; ok: boolean }> {
  console.log(`\n${yellow("You:")} ${message}\n`);

  let result = "";
  let assistantText = "";
  let sessionId = "";
  let ok = true;
  let endError: string | undefined;

  const handle = agent.chat(message);

  for await (const ev of handle) {
    if (ev.kind === "ca_session_started") {
      sessionId = ev.sessionId;
      console.log(dim(`[session ${sessionId} • engine=${ev.engine}]`));
    } else if (ev.kind === "sdk_message") {
      const p = ev.payload as Record<string, unknown>;

      if (p.type === "assistant") {
        const msg = p.message as { content?: unknown[] } | undefined;
        for (const block of msg?.content ?? []) {
          const b = block as { type?: string; text?: string; name?: string; input?: unknown };
          if (b.type === "text" && b.text) {
            process.stdout.write(b.text);
            assistantText += b.text;
          } else if (b.type === "tool_use") {
            const input = JSON.stringify(b.input ?? {});
            console.log(`\n${dim(`  → ${b.name}(${input.slice(0, 120)}${input.length > 120 ? "…" : ""})`)}`);
          }
        }
      } else if (p.type === "tool") {
        const content = typeof p.content === "string" ? p.content : JSON.stringify(p.content);
        console.log(dim(`    ← ${content.slice(0, 200)}${content.length > 200 ? "…" : ""}`));
      } else if (p.type === "result" && typeof p.result === "string") {
        result = p.result;
      }
    } else if (ev.kind === "ca_usage_snapshot") {
      const u = ev as unknown as { input_tokens?: number; output_tokens?: number; cost_usd?: number };
      if (u.cost_usd !== undefined) {
        console.log(`\n${dim(`[usage: in=${u.input_tokens} out=${u.output_tokens} cost=$${u.cost_usd?.toFixed(4)}]`)}`);
      }
    } else if (ev.kind === "ca_session_ended") {
      if (ev.reason !== "complete") {
        ok = false;
        endError = ev.errorMessage ?? ev.reason;
      }
      console.log(`\n${dim(`[ended: ${ev.reason}${ev.errorMessage ? ` — ${ev.errorMessage}` : ""}]`)}`);
    }
  }

  // Fall back to assembled assistant text if there was no terminal `result`.
  // Helps when the engine errors mid-turn — we still surface what came through.
  if (!result && assistantText) result = assistantText;

  const harnessUrl = await agent.harnessUrl();
  if (!ok) {
    console.log(`\n${dim(`[turn failed: ${endError ?? "unknown"} — saved files may be empty/partial]`)}`);
  }
  return { sessionId, result, harnessUrl, ok };
}

interface FsEntry {
  path: string;
  type: string;
  size: number;
}

/** Snapshot of the workdir tree at a point in time. Used to diff at session end. */
async function snapshotWorkdir(harnessUrl: string, sessionId: string): Promise<Map<string, FsEntry>> {
  const out = new Map<string, FsEntry>();
  try {
    const res = await fetch(`${harnessUrl}/v1/sessions/${sessionId}/fs/tree?depth=10`);
    if (!res.ok) return out;
    const tree = (await res.json()) as { entries: FsEntry[] };
    for (const e of tree.entries) out.set(e.path, e);
  } catch {
    // FS API unavailable — return empty snapshot; downstream diff will skip.
  }
  return out;
}

async function saveOutput(filename: string, content: string): Promise<void> {
  const path = join(OUTPUTS_DIR, filename);
  await writeFile(path, content, "utf8");
  console.log(`\n${green("✓")} Saved → ${path}`);
}

async function saveTurnOutput(
  filename: string,
  header: string,
  body: string,
): Promise<void> {
  if (!body.trim()) {
    console.log(`\n${dim(`(skipped ${filename} — empty response from agent)`)}`);
    return;
  }
  await saveOutput(
    filename,
    `# ${header}\n\nGenerated by marketing-agent via ComputerAgent\n\n---\n\n${body}\n`,
  );
}

async function fetchAgentFile(harnessUrl: string, sessionId: string, path: string): Promise<string | null> {
  try {
    const res = await fetch(`${harnessUrl}/v1/sessions/${sessionId}/fs/file?path=${encodeURIComponent(path)}`);
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

await mkdir(OUTPUTS_DIR, { recursive: true });

let priorSessionId: string | undefined;
if (RESUME && existsSync(SESSION_FILE)) {
  priorSessionId = (await readFile(SESSION_FILE, "utf8")).trim();
  console.log(`\nResuming session: ${priorSessionId}`);
}

// Boot the marketing agent from the public GitHub repo.
// LocalSubstrate spawns the harness in a subprocess — no Docker required.
await using agent = new ComputerAgent({
  source: {
    type: "git",
    url: "github.com/open-gitagent/example-marketing-agent",
  },
  harness: "claude-agent-sdk",
  runtime: new LocalSubstrate(),
  envs: { ANTHROPIC_API_KEY },
  options: {
    permissionMode: "bypassPermissions",
    settingSources: ["project"],
  },
  sessionStore: {
    kind: "file",
    options: { root: OUTPUTS_DIR },
  },
  ...(priorSessionId ? { sessionId: priorSessionId } : {}),
});

// Pre-session-start snapshot is empty by definition (we don't have a sessionId
// yet). The snapshot is taken right AFTER turn 1 — at that point the harness
// has materialized the GAP repo into the workdir but the agent hasn't yet
// produced any deliverable files. Anything that appears after this snapshot
// is something the AGENT wrote (issue #3 fix).
let workdirBaseline: Map<string, FsEntry> = new Map();

// ── Turn 1: Product context ───────────────────────────────────────────────────

if (!RESUME) {
  hr("Turn 1 — Product Context");

  const { sessionId, harnessUrl } = await streamTurn(
    agent,
    `Here is our product context. Please confirm you've loaded it and identify the top 3
marketing challenges you'd recommend we tackle first.

Product: an enterprise platform for building, deploying, and governing AI agents at scale.
Audience: Mid-market and enterprise engineering and IT leaders (CTOs, VP Engineering, Head of AI).
Stage: Series A, $8M ARR, 120 customers, growing 15% MoM.
Key differentiators: On-prem / VPC deployment, SOC2 compliant, LLM-agnostic (OpenAI, Anthropic, Gemini, Mistral).
Main competitors: LangChain, CrewAI, Vertex AI Agent Builder.
Current channels: mostly outbound sales, some inbound content, limited PLG motion.
Top conversion barrier: enterprises want a PoC before committing — long evaluation cycles (60-90 days).`,
  );

  // Snapshot once — captures the materialized GAP repo (agent.yaml, SOUL.md,
  // RULES.md, .claude/skills/**, .git/**) so the final FS sweep can exclude it.
  workdirBaseline = await snapshotWorkdir(harnessUrl, sessionId);

  await writeFile(SESSION_FILE, sessionId, "utf8");
  console.log(`\nSession ID saved → ${SESSION_FILE}`);
}

// ── Turn 2: Cold email sequence ───────────────────────────────────────────────

hr("Turn 2 — Cold Email Sequence");

const { result: emailResult } = await streamTurn(
  agent,
  `Write a 4-email cold outreach sequence targeting VP Engineering at Series B+ SaaS companies
(500–2000 employees). The goal of the sequence is to book a 30-minute PoC scoping call.
Angle: they are likely already using LangChain or CrewAI and hitting reliability or governance issues at scale.
Format each email with: Subject line, Body, Send timing.`,
);

await saveTurnOutput(
  "cold-email-sequence.md",
  "Cold Email Sequence — VP Engineering @ Series B+ SaaS",
  emailResult,
);

// ── Turn 3: Pricing strategy ──────────────────────────────────────────────────

hr("Turn 3 — Pricing Strategy");

const { result: pricingResult } = await streamTurn(
  agent,
  `Design a 3-tier pricing structure for an enterprise AI-agent platform. We currently charge flat enterprise contracts
($3k–$15k/month). We want to add a self-serve tier to capture PLG motion and reduce the
60-90 day sales cycle for smaller deals. Include:
- Tier names and positioning
- Pricing metric recommendation (per-seat vs. per-agent vs. usage-based)
- Feature gates between tiers
- Recommended price points with reasoning
- A/B test ideas for the pricing page`,
);

await saveTurnOutput("pricing-strategy.md", "Pricing Strategy — Example AI Platform", pricingResult);

// ── Turn 4: Launch strategy for self-serve tier ───────────────────────────────

hr("Turn 4 — Self-Serve Launch Strategy");

const { result: launchResult, sessionId: finalSession, harnessUrl } = await streamTurn(
  agent,
  `Now create a 30-day launch plan for the new self-serve tier.
We want 500 signups in the first 30 days. Channels available: Product Hunt, HN Show,
our existing email list (4,200 subscribers), LinkedIn (8k followers), and developer communities.
Include: Pre-launch checklist, launch day playbook, week-by-week activation plan,
success metrics, and the top 3 risks with mitigations.`,
);

await saveTurnOutput(
  "launch-strategy.md",
  "Self-Serve Launch Strategy — 30-Day Plan",
  launchResult,
);

// ── Bonus: capture files the AGENT wrote (not the materialized GAP repo) ─────
//
// Diffs the current workdir against the baseline snapshot taken after turn 1.
// Anything new (or grown) is something the agent itself produced via its
// Write/Bash tools. The materialized GAP repo (agent.yaml, SKILL.md files,
// .git/**) is excluded. See issue #3 for context.

hr("Harness Filesystem");

const finalTree = await snapshotWorkdir(harnessUrl, finalSession);
const newFiles: FsEntry[] = [];
for (const [path, entry] of finalTree) {
  if (entry.type !== "file") continue;
  const before = workdirBaseline.get(path);
  if (!before) {
    newFiles.push(entry);   // brand new file
  } else if (before.size !== entry.size) {
    newFiles.push(entry);   // existed before but was modified
  }
}

if (newFiles.length === 0) {
  console.log(dim("  (agent didn't write any files to its workspace — all output was inline text)"));
  console.log(dim("  Note: the materialized GAP repo is excluded from this view."));
} else {
  console.log("\nFiles the agent wrote during this session:");
  for (const e of newFiles) {
    console.log(`  file ${e.path.padEnd(50)} ${e.size}b`);
    const content = await fetchAgentFile(harnessUrl, finalSession, e.path);
    if (content) {
      // Drop leading slash; preserve subdirectory structure with "/" → "_"
      const outName = e.path.replace(/^\//, "").replace(/\//g, "_");
      await saveOutput(outName, content);
    }
  }
}

// ── Summary ───────────────────────────────────────────────────────────────────

hr("Done");
console.log(`\nAll outputs saved to: ${OUTPUTS_DIR}/`);
console.log("  cold-email-sequence.md   — 4-email VP Engineering outreach sequence");
console.log("  pricing-strategy.md      — 3-tier SaaS pricing with feature gates");
console.log("  launch-strategy.md       — 30-day self-serve launch plan");
console.log(`\nSession ID: ${finalSession}`);
console.log("Run with 'resume' to continue this session in a fresh process:");
console.log(`  ANTHROPIC_API_KEY=sk-... bun run examples/marketing-agent.ts resume\n`);
