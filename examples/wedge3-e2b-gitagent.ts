/**
 * Wedge 3b demo — gitagent engine flavor.
 *
 * Same architecture as wedge3-e2b-demo.ts but uses the `gitagent` (gitclaw)
 * engine instead of `claude-agent-sdk`. Proves both engines work inside the
 * same E2B substrate.
 *
 * Run:
 *   ANTHROPIC_API_KEY=sk-ant-... E2B_API_KEY=e2b_... \
 *     bun run examples/wedge3-e2b-gitagent.ts
 */

import { ComputerAgent } from "@open-gitagent/sdk";
import { E2BSubstrate } from "@computeragent/runtime-e2b";

const anthropicKey = process.env.ANTHROPIC_API_KEY;
const e2bKey = process.env.E2B_API_KEY;
if (!anthropicKey || !e2bKey) {
  console.error("Both ANTHROPIC_API_KEY and E2B_API_KEY must be set");
  process.exit(1);
}

const agent = new ComputerAgent({
  source: {
    type: "inline",
    manifest: { name: "wedge3-gitagent-writer", version: "0.1.0" },
    files: {
      "agent.yaml": [
        'spec_version: "0.1.0"',
        "name: wedge3-gitagent-writer",
        "version: 0.1.0",
        "description: gitagent flavor of the Wedge 3b writer demo",
        "model:",
        "  preferred: anthropic:claude-sonnet-4-5-20250929",
        "runtime:",
        "  max_turns: 6",
      ].join("\n"),
      "SOUL.md": [
        "# Soul",
        "",
        "I am a minimal coding agent built on gitclaw. When asked to produce a file:",
        "- Use the Write tool to create it in the current working directory",
        "- Keep outputs short",
        "- Do not ask for confirmation",
      ].join("\n"),
    },
  },
  harness: "gitagent",
  envs: { ANTHROPIC_API_KEY: anthropicKey },
  runtime: new E2BSubstrate({
    apiKey: e2bKey,
    onLog: (line) => process.stderr.write(`[e2b] ${line}\n`),
  }),
  options: {
    model: "anthropic:claude-sonnet-4-5-20250929",
    maxTurns: 6,
  },
});

try {
  console.log("1. agent.chat(...)  — gitagent engine inside E2B");
  const handle = agent.chat(
    "Create a file named gitagent-hello.md containing exactly:\n\n" +
      "# Hello from gitagent\n\n" +
      "This file was written by an agent on the gitagent engine in an E2B sandbox.\n\n" +
      'Then respond with just "done".',
  );

  for await (const ev of handle) {
    if (ev.kind === "ca_session_started") {
      console.log(`   [start] sessionId=${ev.sessionId}, engine=${ev.engine}`);
    } else if (ev.kind === "sdk_message") {
      const p = ev.payload as { type?: string; content?: string; toolName?: string; subtype?: string };
      if (p.type === "assistant" && typeof p.content === "string") {
        console.log(`   [assistant] ${p.content.slice(0, 80)}`);
      } else if (p.type === "tool_use") {
        console.log(`   [tool] ${p.toolName}`);
      } else if (p.type === "system") {
        console.log(`   [system] ${p.subtype}`);
      }
    } else if (ev.kind === "ca_session_ended") {
      console.log(`   [end] reason=${ev.reason}${ev.errorMessage ? `  error=${ev.errorMessage}` : ""}`);
    }
  }

  const sessionId = await handle.sessionId();
  const harnessUrl = await agent.harnessUrl();

  console.log(`\n2. GET ${harnessUrl}/v1/sessions/${sessionId}/fs/tree`);
  const tree = (await (await fetch(`${harnessUrl}/v1/sessions/${sessionId}/fs/tree?depth=1`)).json()) as {
    entries: { path: string; type: string; size: number }[];
  };
  for (const e of tree.entries) {
    console.log(`   ${e.type.padEnd(4)} ${e.path.padEnd(28)} ${e.size}b`);
  }

  // gitclaw's local Write tool tends to place files under a `workspace/` subdir.
  // Look up the actual location from the tree rather than guessing.
  const writtenPath =
    tree.entries.find((e) => e.path.endsWith("gitagent-hello.md"))?.path ??
    "gitagent-hello.md";
  console.log(`\n3. GET ${harnessUrl}/v1/sessions/${sessionId}/fs/file?path=${writtenPath}`);
  const fileText = await (
    await fetch(`${harnessUrl}/v1/sessions/${sessionId}/fs/file?path=${writtenPath}`)
  ).text();
  console.log("   ----- begin file -----");
  console.log(fileText.split("\n").map((l) => `   ${l}`).join("\n"));
  console.log("   ----- end file -----");
} finally {
  console.log(`\n4. dispose() — tearing down the sandbox`);
  await agent.dispose();
  console.log("   ok");
}
