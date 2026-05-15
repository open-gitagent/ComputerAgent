/**
 * The smallest useful ComputerAgent program.
 *
 *   ANTHROPIC_API_KEY=sk-ant-... bun run examples/hello.ts
 *
 * Tell the agent to write something to a file, then read it back. Shows the
 * full loop in ~20 lines: define an agent inline, run it locally with the
 * Claude Agent SDK engine, fetch the file the agent produced. No GitHub
 * repo, no Docker, no E2B account — just the API key.
 */
import { ComputerAgent, LocalSubstrate } from "computeragent";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) throw new Error("Set ANTHROPIC_API_KEY first.");

await using agent = new ComputerAgent({
  source: {
    type: "inline",
    manifest: { name: "haiku-bot", version: "0.1.0" },
    files: {
      "agent.yaml": [
        'spec_version: "0.1.0"',
        "name: haiku-bot",
        "version: 0.1.0",
        "model:",
        "  preferred: claude-haiku-4-5-20251001",
      ].join("\n"),
      "SOUL.md": "Write the requested content to the requested file with the Write tool. Stay terse.",
    },
  },
  harness: "claude-agent-sdk",
  runtime: new LocalSubstrate(),
  envs: { ANTHROPIC_API_KEY },
  options: { permissionMode: "bypassPermissions" },
});

const result = await agent.chat('Write a 3-line haiku about TypeScript to "haiku.txt".');
const haiku = await agent.fetchArtifactText("haiku.txt");

console.log(`\n${haiku ?? "(no file produced)"}\n`);
console.log(
  `${result.usage.inputTokens + result.usage.outputTokens} tokens • ` +
    `$${result.usage.costUsd?.toFixed(4) ?? "?"} • ` +
    `session ${result.sessionId}`,
);
