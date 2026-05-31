/**
 * Generate a PDF via the public pdf-agent GAP repo.
 *
 *   ANTHROPIC_API_KEY=sk-ant-... bun run examples/pdf-agent.ts "<topic>"
 *
 *   # With a default if no argv:
 *   ANTHROPIC_API_KEY=sk-ant-... bun run examples/pdf-agent.ts
 *
 * The agent uses reportlab + Platypus to produce a multi-page paginated PDF;
 * we pull it locally via agent.fetchArtifact() into examples/pdfs/.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ComputerAgent, LocalSubstrate } from "computeragent";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) throw new Error("Set ANTHROPIC_API_KEY first.");

const TOPIC =
  process.argv[2] ??
  "Q3 2026 business review report for an example company. Sections: executive summary, revenue performance (with a 3-row table showing SMB/Mid-market/Enterprise), product milestones, risks (with a callout), and Q4 outlook. Author: Finance Team.";

const OUT = join(import.meta.dir ?? __dirname, "pdfs");
await mkdir(OUT, { recursive: true });

console.log(`\nTopic: ${TOPIC}\nOutput dir: ${OUT}\n`);

await using agent = new ComputerAgent({
  source: { type: "git", url: "github.com/open-gitagent/example-pdf-agent" },
  harness: "claude-agent-sdk",
  runtime: new LocalSubstrate(),
  envs: { ANTHROPIC_API_KEY },
  options: { permissionMode: "bypassPermissions", settingSources: ["project"] },
});

const startedAt = Date.now();
let toolCalls = 0;

const handle = agent.chat(TOPIC);

for await (const ev of handle) {
  if (ev.kind === "ca_session_started") {
    console.log(`[session ${ev.sessionId}]\n`);
  } else if (ev.kind === "sdk_message") {
    const p = ev.payload as Record<string, unknown>;
    if (p.type === "assistant") {
      const msg = p.message as { content?: { type: string; text?: string; name?: string; input?: unknown }[] };
      for (const block of msg.content ?? []) {
        if (block.type === "text" && block.text) {
          process.stdout.write(block.text);
        } else if (block.type === "tool_use") {
          toolCalls++;
          const inp = JSON.stringify(block.input ?? {}).slice(0, 140);
          console.log(`\n  → ${block.name}(${inp}${inp.length >= 140 ? "…" : ""})`);
        }
      }
    } else if (p.type === "user") {
      const msg = p.message as { content?: { type: string; content?: unknown }[] };
      for (const block of msg.content ?? []) {
        if (block.type === "tool_result") {
          const content = typeof block.content === "string" ? block.content : JSON.stringify(block.content);
          console.log(`    ← ${content.slice(0, 180)}${content.length > 180 ? "…" : ""}`);
        }
      }
    }
  } else if (ev.kind === "ca_session_ended") {
    console.log(`\n[ended: ${ev.reason}${ev.errorMessage ? ` — ${ev.errorMessage}` : ""}]`);
  }
}

const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
const usage = handle.getUsage();
console.log(`\n${"─".repeat(70)}`);
console.log(`Agent done in ${elapsed}s • ${toolCalls} tool calls • ${usage.inputTokens + usage.outputTokens} tokens • $${usage.costUsd?.toFixed(4) ?? "?"}\n`);

// Find the .pdf the agent produced.
const tree = await agent.listWorkdir({ depth: 2 });
const pdfs = tree.filter((e) => e.type === "file" && e.path.toLowerCase().endsWith(".pdf"));

if (pdfs.length === 0) {
  console.error("✗ No .pdf file found in workdir.");
  console.error("  Workdir contents:");
  for (const e of tree.filter((x) => x.type === "file" && !x.path.startsWith("."))) {
    console.error(`    ${e.path.padEnd(40)} ${e.size}b`);
  }
  process.exit(1);
}

pdfs.sort((a, b) => b.size - a.size);
const winner = pdfs[0]!;
const bytes = await agent.fetchArtifact(winner.path);

if (!bytes) {
  console.error(`✗ fetchArtifact returned null for ${winner.path}`);
  process.exit(1);
}

// PDF magic bytes: %PDF (0x25 0x50 0x44 0x46)
const looksLikePdf =
  bytes.length >= 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
if (!looksLikePdf) {
  console.error(
    `✗ ${winner.path} doesn't look like a valid PDF. First bytes: ${Array.from(bytes.slice(0, 4))
      .map((b) => String.fromCharCode(b))
      .join("")}`,
  );
  process.exit(1);
}

const localName = winner.path.replace(/^\//, "");
const localPath = join(OUT, localName);
await writeFile(localPath, bytes);

console.log(`✓ Saved → ${localPath}`);
console.log(`  ${bytes.length.toLocaleString()} bytes • %PDF magic verified`);
console.log(`\nOpen with:\n  open "${localPath}"\n`);
