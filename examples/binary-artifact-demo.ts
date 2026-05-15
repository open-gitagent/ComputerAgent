/**
 * Binary artifact demo (issue #1).
 *
 * Demonstrates the first-class path for getting binary files OUT of an agent
 * run: the agent uses its Write + Bash tools to produce a .zip archive in
 * the workdir, then the SDK pulls it with `agent.fetchArtifact()`.
 *
 * The agent uses only Python's stdlib (`zipfile`, `csv`, `json`) — no
 * `pip install` step, no third-party deps. So the same code works
 * unchanged against LocalSubstrate, E2BSubstrate, or VZVMSubstrate.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-ant-... bun run examples/binary-artifact-demo.ts
 *
 * Output:
 *   examples/binary-outputs/quarterly-report-bundle.zip
 *   examples/binary-outputs/quarterly-report-bundle.zip.manifest.json
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ComputerAgent, LocalSubstrate } from "computeragent";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) {
  console.error("Error: ANTHROPIC_API_KEY is not set.");
  process.exit(1);
}

const OUT = join(import.meta.dir ?? __dirname, "binary-outputs");
await mkdir(OUT, { recursive: true });

await using agent = new ComputerAgent({
  source: {
    type: "inline",
    manifest: { name: "binary-artifact-demo", version: "0.1.0" },
    files: {
      "agent.yaml": [
        'spec_version: "0.1.0"',
        "name: binary-artifact-demo",
        "version: 0.1.0",
        "model:",
        "  preferred: claude-haiku-4-5-20251001",
        "runtime:",
        "  max_turns: 8",
      ].join("\n"),
      "SOUL.md":
        "You produce binary artifacts via Python's standard library. " +
        "Use the Write tool for source files and the Bash tool to run python3. " +
        "Stay terse. Confirm with one short sentence when done.",
    },
  },
  harness: "claude-agent-sdk",
  runtime: new LocalSubstrate(),
  envs: { ANTHROPIC_API_KEY },
  options: {
    permissionMode: "bypassPermissions",
    settingSources: ["project"],
    model: "claude-haiku-4-5-20251001",
    maxTurns: 8,
  },
});

const TASK = `Build a small Python script that uses only the standard library
(\`zipfile\`, \`csv\`, \`json\`, \`io\`) to create a ZIP archive named
\`quarterly-report-bundle.zip\` in the current working directory.

The archive must contain exactly these three files:

1. \`report.md\` — a short markdown summary (5–8 lines) of a fake quarterly
   business review. Make up plausible numbers.

2. \`metrics.csv\` — 5 rows of fake metrics with columns:
   \`metric_name,q1_value,q2_value,q3_value,q4_value\`

3. \`metadata.json\` — \`{ "generated_at": "<ISO timestamp>", "version": "1.0", "row_count": 5 }\`

Steps:
1. Write the script to \`make_bundle.py\`
2. Run it with \`python3 make_bundle.py\`
3. Confirm \`quarterly-report-bundle.zip\` exists with \`ls -la\`
4. Reply with one line: "done — quarterly-report-bundle.zip"`;

console.log("Asking the agent to generate a .zip via Python stdlib…\n");
console.log(`TASK:\n${TASK}\n${"─".repeat(70)}\n`);

const startedAt = Date.now();
let toolCalls = 0;

const handle = agent.chat(TASK);
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
          const input = JSON.stringify(block.input ?? {}).slice(0, 180);
          console.log(`\n  → ${block.name}(${input}${input.length >= 180 ? "…" : ""})`);
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
console.log(`Agent done in ${elapsed}s • ${toolCalls} tool calls • ${usage.inputTokens + usage.outputTokens} tokens • $${usage.costUsd?.toFixed(4) ?? "?"}`);

// ── Pull the artifact ──────────────────────────────────────────────────────

console.log(`\nListing workdir to confirm the artifact landed…`);
const tree = await agent.listWorkdir({ depth: 1 });
const interesting = tree.filter((e) => e.type === "file" && !e.path.startsWith(".") && e.path !== "agent.yaml" && e.path !== "SOUL.md");
for (const entry of interesting) {
  console.log(`  ${entry.type.padEnd(4)} ${entry.path.padEnd(40)} ${entry.size.toString().padStart(8)}b`);
}

console.log(`\nFetching quarterly-report-bundle.zip via agent.fetchArtifact()…`);
const bytes = await agent.fetchArtifact("quarterly-report-bundle.zip");
if (!bytes) {
  console.error("✗ Artifact not found in workdir.");
  process.exit(1);
}

// Sanity-check the bytes — every ZIP starts with "PK\x03\x04" (local file header).
const looksLikeZip = bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
if (!looksLikeZip) {
  console.error(`✗ File doesn't look like a valid ZIP. Magic bytes: ${Array.from(bytes.slice(0, 4))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(" ")}`);
  process.exit(1);
}

const localPath = join(OUT, "quarterly-report-bundle.zip");
await writeFile(localPath, bytes);
console.log(`✓ Saved → ${localPath}  (${bytes.length}b, ZIP magic verified)`);

// Bonus: also save a manifest of what's in the workdir alongside.
const manifest = {
  artifact: "quarterly-report-bundle.zip",
  bytes: bytes.length,
  sessionId: await handle.sessionId(),
  generatedAt: new Date().toISOString(),
  agentUsage: usage,
  workdirEntries: interesting,
};
const manifestPath = `${localPath}.manifest.json`;
await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
console.log(`✓ Manifest → ${manifestPath}`);

console.log(`\nNext:`);
console.log(`  unzip -p ${localPath} report.md     # see the agent's report`);
console.log(`  unzip -p ${localPath} metrics.csv   # see its CSV`);
console.log(`  unzip -p ${localPath} metadata.json # see its JSON`);
