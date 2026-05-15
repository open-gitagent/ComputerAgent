#!/usr/bin/env node
/**
 * `npx create-computeragent <project-name>`
 *
 * Scaffolds a runnable ComputerAgent project in one command. The output is a
 * single TS file + a package.json that depends on the published packages, so
 * the user can:
 *
 *   npx create-computeragent my-agent
 *   cd my-agent
 *   npm install
 *   ANTHROPIC_API_KEY=sk-... npm start
 *
 * No prompts, no questions — opinionated defaults, runnable in under a minute.
 */
import { mkdir, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, basename, join } from "node:path";

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith("--"));
const flags = new Set(args.filter((a) => a.startsWith("--")));

if (flags.has("--help") || flags.has("-h")) {
  printHelp();
  process.exit(0);
}

const projectName = positional[0] ?? "my-computeragent";
const targetDir = resolve(process.cwd(), projectName);

if (existsSync(targetDir)) {
  const dirContents = await readdir(targetDir).catch(() => [] as string[]);
  if (dirContents.length > 0 && !flags.has("--force")) {
    console.error(`Error: '${projectName}' already exists and is not empty.`);
    console.error(`Use --force to overwrite, or pick a different name.`);
    process.exit(1);
  }
}

await mkdir(targetDir, { recursive: true });

await writeFile(
  join(targetDir, "package.json"),
  JSON.stringify(
    {
      name: basename(projectName),
      version: "0.1.0",
      private: true,
      type: "module",
      scripts: {
        start: "node --experimental-strip-types index.ts",
      },
      dependencies: {
        computeragent: "^0.1.0",
      },
      engines: { node: ">=22.6.0" },
    },
    null,
    2,
  ),
);

await writeFile(
  join(targetDir, "index.ts"),
  `import { runTask, LocalSubstrate } from "computeragent";

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error("Set ANTHROPIC_API_KEY first.");
  console.error("  export ANTHROPIC_API_KEY=sk-ant-...");
  process.exit(1);
}

const result = await runTask({
  source: {
    type: "inline",
    manifest: { name: "${basename(projectName)}", version: "0.1.0" },
    files: {
      "agent.yaml": [
        'spec_version: "0.1.0"',
        "name: ${basename(projectName)}",
        "version: 0.1.0",
        "model:",
        "  preferred: claude-haiku-4-5-20251001",
        "runtime:",
        "  max_turns: 4",
      ].join("\\n"),
      "SOUL.md": [
        "# Soul",
        "",
        "You are a friendly assistant. Respond concisely.",
        "When asked to write a file, use the Write tool.",
      ].join("\\n"),
    },
  },
  harness: "claude-agent-sdk",
  envs: { ANTHROPIC_API_KEY: apiKey },
  runtime: new LocalSubstrate(),
  options: { permissionMode: "bypassPermissions", settingSources: ["project"] },
  message: "Say hi and tell me one thing you can do.",
});

for (const m of result.messages) {
  const msg = m as { type?: string; result?: string; message?: { content?: unknown[] } };
  if (msg.type === "result" && msg.result) {
    console.log("\\nA:", msg.result);
  }
}
console.log("\\nSession:", result.sessionId, "(reason:", result.ended.reason + ")");
`,
);

await writeFile(
  join(targetDir, ".gitignore"),
  ["node_modules", "dist", ".env", ".env.local", "*.log", ""].join("\n"),
);

await writeFile(
  join(targetDir, "README.md"),
  `# ${basename(projectName)}

A starter [ComputerAgent](https://github.com/open-gitagent/ComputerAgent) project.

## Run

\`\`\`bash
npm install
ANTHROPIC_API_KEY=sk-ant-... npm start
\`\`\`

## What this is

A minimal agent defined inline in \`index.ts\` and run in a local subprocess via \`runTask\`.
The substrate boots, the agent runs one turn, the substrate is torn down — all in one call.

## Swap the substrate

Replace \`new LocalSubstrate()\` with \`new E2BSubstrate({apiKey})\` for a cloud sandbox,
or \`new VZVMSubstrate({...})\` for an Apple Silicon VM. Same code, different runtime.

\`\`\`bash
npm install @computeragent/runtime-e2b
\`\`\`

## Add memory

Pass \`sessionStore: { kind: "file", options: { root: "./sessions" } }\` and the same
\`sessionId\` on a follow-up call to resume the conversation across processes.

See https://github.com/open-gitagent/ComputerAgent for the full guide.
`,
);

console.log(``);
console.log(`✓ Created ${projectName}/`);
console.log(``);
console.log(`Next:`);
console.log(`  cd ${projectName}`);
console.log(`  npm install`);
console.log(`  export ANTHROPIC_API_KEY=sk-ant-...`);
console.log(`  npm start`);
console.log(``);
console.log(`Docs: https://github.com/open-gitagent/ComputerAgent`);
console.log(``);

function printHelp(): void {
  console.log(`create-computeragent — scaffold a ComputerAgent project`);
  console.log(``);
  console.log(`Usage:`);
  console.log(`  npx create-computeragent <project-name> [--force]`);
  console.log(``);
  console.log(`Options:`);
  console.log(`  --force    Overwrite a non-empty target directory`);
  console.log(`  --help     Show this message`);
  console.log(``);
  console.log(`Example:`);
  console.log(`  npx create-computeragent my-agent`);
  console.log(`  cd my-agent && npm install && ANTHROPIC_API_KEY=sk-... npm start`);
}
