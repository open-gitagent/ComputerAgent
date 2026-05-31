/**
 * Generate a PowerPoint deck via the public ppt-agent GAP repo.
 *
 *   ANTHROPIC_API_KEY=sk-ant-... bun run examples/ppt-agent.ts "<topic + audience>"
 *
 *   # With a default topic if no argv:
 *   ANTHROPIC_API_KEY=sk-ant-... bun run examples/ppt-agent.ts
 *
 * The agent writes the .pptx into its workdir; we pull it locally via
 * agent.fetchArtifact() and save it under examples/decks/.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ComputerAgent, LocalSubstrate } from "computeragent";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) throw new Error("Set ANTHROPIC_API_KEY first.");

const TOPIC =
  process.argv[2] ??
  "10-slide investor deck for an example AI startup. Audience: Series A VCs. Tone: confident, data-driven.";

const OUT = join(import.meta.dir ?? __dirname, "decks");
await mkdir(OUT, { recursive: true });

console.log(`\nTopic: ${TOPIC}\nOutput dir: ${OUT}\n`);

await using agent = new ComputerAgent({
  source: { type: "git", url: "github.com/open-gitagent/example-ppt-agent" },
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

// Find the .pptx the agent produced.
const tree = await agent.listWorkdir({ depth: 2 });
const pptxFiles = tree.filter((e) => e.type === "file" && e.path.toLowerCase().endsWith(".pptx"));

if (pptxFiles.length === 0) {
  console.error("✗ No .pptx file found in workdir.");
  console.error("  Workdir contents:");
  for (const e of tree.filter((x) => x.type === "file" && !x.path.startsWith("."))) {
    console.error(`    ${e.path.padEnd(40)} ${e.size}b`);
  }
  process.exit(1);
}

// Save the largest .pptx (in case the agent wrote multiple, take the real one)
pptxFiles.sort((a, b) => b.size - a.size);
const winner = pptxFiles[0]!;
const bytes = await agent.fetchArtifact(winner.path);

if (!bytes) {
  console.error(`✗ fetchArtifact returned null for ${winner.path}`);
  process.exit(1);
}

// PowerPoint files are ZIP archives — verify magic bytes (PK\x03\x04)
const looksLikePptx =
  bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
if (!looksLikePptx) {
  console.error(
    `✗ ${winner.path} doesn't look like a valid .pptx (ZIP) file. First bytes: ${Array.from(bytes.slice(0, 4))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join(" ")}`,
  );
  process.exit(1);
}

const localName = winner.path.replace(/^\//, "");
const localPath = join(OUT, localName);
await writeFile(localPath, bytes);

console.log(`✓ Saved → ${localPath}`);
console.log(`  ${bytes.length.toLocaleString()} bytes • ZIP magic verified`);
console.log(`\nOpen with:\n  open "${localPath}"\n`);
