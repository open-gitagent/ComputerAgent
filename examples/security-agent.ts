/**
 * Security code reviewer demo.
 *
 * Runs the github.com/shreyas-lyzr/security-agent GAP repo against any
 * target repository. Output is a single SECURITY_REVIEW.md fetched from
 * the harness workdir.
 *
 * Usage:
 *
 *   # Public repo
 *   ANTHROPIC_API_KEY=sk-ant-... bun run examples/security-agent.ts \
 *     https://github.com/<owner>/<repo>
 *
 *   # Private repo — supply a GitHub PAT
 *   ANTHROPIC_API_KEY=sk-ant-... GITHUB_TOKEN=ghp_... \
 *     bun run examples/security-agent.ts https://github.com/<owner>/<private>
 *
 *   # Default target (a tiny intentionally-vulnerable demo) if no argv
 *   ANTHROPIC_API_KEY=sk-ant-... bun run examples/security-agent.ts
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ComputerAgent, LocalSubstrate } from "computeragent";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) {
  console.error("Error: ANTHROPIC_API_KEY is not set.");
  process.exit(1);
}

const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? "";
const TARGET = process.argv[2] ?? "https://github.com/OWASP/NodeGoat";

const OUT = join(import.meta.dir ?? __dirname, "security-reports");
await mkdir(OUT, { recursive: true });

console.log(`Target:       ${TARGET}`);
console.log(`GITHUB_TOKEN: ${GITHUB_TOKEN ? "(set — private repos accessible)" : "(not set — public only)"}`);
console.log(`Output dir:   ${OUT}\n`);

await using agent = new ComputerAgent({
  source: { type: "git", url: "github.com/shreyas-lyzr/security-agent" },
  harness: "claude-agent-sdk",
  runtime: new LocalSubstrate(),
  envs: {
    ANTHROPIC_API_KEY,
    ...(GITHUB_TOKEN ? { GITHUB_TOKEN } : {}),
  },
  options: {
    permissionMode: "bypassPermissions",
    settingSources: ["project"],
    maxTurns: 60,
  },
});

const startedAt = Date.now();
let sessionId = "";
let harnessUrl = "";
let toolCalls = 0;
let endedReason = "";

const message = `Audit the repository at ${TARGET} for security issues.

Steps:
1. Clone it (use GITHUB_TOKEN if the repo is private and the env var is set)
2. Walk the codebase across all nine categories from your skill
3. Write SECURITY_REVIEW.md to the current working directory
4. Reply with one line confirming the path

Be thorough but realistic — every Critical finding must have an explicit exploit path. Skip noise.`;

console.log("Asking the agent to audit. This typically runs 1-5 minutes depending on repo size.\n");
console.log(`PROMPT:\n${message}\n${"─".repeat(70)}\n`);

const handle = agent.chat(message);

for await (const ev of handle) {
  if (ev.kind === "ca_session_started") {
    sessionId = ev.sessionId;
    harnessUrl = await agent.harnessUrl();
    console.log(`[session ${sessionId}]\n`);
  } else if (ev.kind === "sdk_message") {
    const p = ev.payload as Record<string, unknown>;
    if (p.type === "assistant") {
      const msg = p.message as { content?: { type: string; text?: string; name?: string; input?: unknown }[] };
      for (const block of msg.content ?? []) {
        if (block.type === "text" && block.text) {
          process.stdout.write(block.text);
        } else if (block.type === "tool_use") {
          toolCalls++;
          const inp = JSON.stringify(block.input ?? {}).slice(0, 160);
          console.log(`\n  → ${block.name}(${inp}${inp.length >= 160 ? "…" : ""})`);
        }
      }
    } else if (p.type === "user") {
      const msg = p.message as { content?: { type: string; content?: unknown }[] };
      for (const block of msg.content ?? []) {
        if (block.type === "tool_result") {
          const content = typeof block.content === "string"
            ? block.content
            : JSON.stringify(block.content);
          console.log(`    ← ${content.slice(0, 200)}${content.length > 200 ? "…" : ""}`);
        }
      }
    }
  } else if (ev.kind === "ca_session_ended") {
    endedReason = ev.reason + (ev.errorMessage ? ` — ${ev.errorMessage}` : "");
    console.log(`\n[ended: ${endedReason}]`);
  }
}

const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
const usage = handle.getUsage();
const totalTokens = usage.inputTokens + usage.outputTokens;

console.log(`\n${"─".repeat(70)}`);
console.log(`Done in ${elapsed}s • ${toolCalls} tool calls • status: ${endedReason}`);
console.log(
  `Usage: ${usage.inputTokens.toLocaleString()} in + ${usage.outputTokens.toLocaleString()} out` +
  (usage.cacheReadInputTokens > 0
    ? ` (cache read: ${usage.cacheReadInputTokens.toLocaleString()})`
    : "") +
  (usage.cacheCreationInputTokens > 0
    ? ` (cache write: ${usage.cacheCreationInputTokens.toLocaleString()})`
    : "") +
  ` = ${totalTokens.toLocaleString()} tokens` +
  (usage.costUsd !== undefined ? ` • $${usage.costUsd.toFixed(4)}` : "") +
  "\n",
);

// Pull SECURITY_REVIEW.md from the workdir.
// (The agent writes it inside the cloned-target subdirectory.)
const treeRes = await fetch(`${harnessUrl}/v1/sessions/${sessionId}/fs/tree?depth=10`);
let reportPath: string | undefined;
if (treeRes.ok) {
  const tree = (await treeRes.json()) as { entries: { path: string; type: string; size: number }[] };
  const candidates = tree.entries.filter(
    (e) => e.type === "file" && e.path.toLowerCase().endsWith("security_review.md"),
  );
  if (candidates.length > 0) {
    // Prefer the largest one (most content) if multiple.
    candidates.sort((a, b) => b.size - a.size);
    reportPath = candidates[0]!.path;
  }
}

if (!reportPath) {
  console.error("✗ SECURITY_REVIEW.md not found in harness workdir.");
  console.error("  The agent may have errored out or written under a different name.");
  process.exit(1);
}

const fileRes = await fetch(
  `${harnessUrl}/v1/sessions/${sessionId}/fs/file?path=${encodeURIComponent(reportPath)}`,
);
const body = await fileRes.text();

// Save with a safe local name derived from the target.
const safeTargetName = TARGET.replace(/^https?:\/\//, "")
  .replace(/[^a-zA-Z0-9_-]+/g, "_")
  .slice(0, 80);
const stamp = new Date().toISOString().slice(0, 10);
const localPath = join(OUT, `${safeTargetName}_${stamp}.md`);
await writeFile(localPath, body, "utf8");

console.log(`✓ Report saved → ${localPath}  (${body.length}b)`);
console.log(`\nFirst 40 lines:\n${"─".repeat(70)}`);
console.log(body.split("\n").slice(0, 40).map((l) => "  " + l).join("\n"));
console.log(`${"─".repeat(70)}\n(full report at ${localPath})`);
