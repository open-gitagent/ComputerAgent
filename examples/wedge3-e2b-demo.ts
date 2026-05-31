/**
 * Wedge 3b demo — same fs-tour as Wedge 2 but the harness server runs INSIDE
 * an E2B cloud sandbox. The only line that changes for the caller is the
 * `runtime` option.
 *
 * Architectural significance: this proves the third axis (substrate) is real.
 * Identity (GAP) × engine (claude-agent-sdk) × substrate (E2B) — all three
 * swappable independently, all three demonstrated end-to-end.
 *
 * Prereqs:
 *   - ANTHROPIC_API_KEY (forwarded to the sandbox)
 *   - E2B_API_KEY (used to create the sandbox)
 *
 * Run:
 *   ANTHROPIC_API_KEY=sk-ant-... E2B_API_KEY=e2b_... \
 *     bun run examples/wedge3-e2b-demo.ts
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
    manifest: { name: "wedge3-writer", version: "0.1.0" },
    files: {
      "agent.yaml": [
        'spec_version: "0.1.0"',
        "name: wedge3-writer",
        "version: 0.1.0",
        "description: Writer agent for the Wedge 3 (E2B substrate) demo",
        "model:",
        "  preferred: claude-sonnet-4-5-20250929",
        "runtime:",
        "  max_turns: 6",
      ].join("\n"),
      "SOUL.md": [
        "# Soul",
        "",
        "I am a minimal coding agent. When asked to produce a file:",
        "- Use the Write tool to create it in the current working directory",
        "- Keep outputs short",
        "- Do not ask for confirmation",
      ].join("\n"),
    },
  },
  harness: "claude-agent-sdk",
  envs: { ANTHROPIC_API_KEY: anthropicKey },
  runtime: new E2BSubstrate({
    apiKey: e2bKey,
    onLog: (line) => process.stderr.write(`[e2b] ${line}\n`),
  }),
  options: {
    permissionMode: "bypassPermissions",
    settingSources: ["project"],
    // The Claude SDK ships per-platform native binaries as optional deps and
    // sometimes picks musl when the sandbox is glibc. Point it at the glibc
    // binary explicitly. (E2B's default template is Ubuntu / glibc.)
    pathToClaudeCodeExecutable:
      "/home/user/harness/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude",
  },
});

try {
  console.log("1. agent.chat(...)  — substrate boots lazily on first call");
  const handle = agent.chat(
    "Create a file named greetings.md containing exactly:\n\n" +
      "# Hello from the cloud\n\n" +
      "This file was written by an agent running in an E2B sandbox.\n\n" +
      'Then respond with just "done".',
  );

  for await (const ev of handle) {
    if (ev.kind === "ca_session_started") {
      console.log(`   [start] sessionId=${ev.sessionId}`);
    } else if (ev.kind === "sdk_message") {
      const p = ev.payload as { type?: string; result?: string };
      if (p.type === "result" && p.result) {
        console.log(`   [result] ${p.result.slice(0, 80)}`);
      }
    } else if (ev.kind === "ca_session_ended") {
      console.log(`   [end] reason=${ev.reason}${ev.errorMessage ? `  error=${ev.errorMessage}` : ""}`);
    }
  }

  const sessionId = await handle.sessionId();
  const harnessUrl = await agent.harnessUrl();

  console.log(`\n2. GET ${harnessUrl}/v1/sessions/${sessionId}/fs/tree   (workdir lives in the sandbox)`);
  const tree = (await (await fetch(`${harnessUrl}/v1/sessions/${sessionId}/fs/tree?depth=1`)).json()) as {
    entries: { path: string; type: string; size: number }[];
  };
  for (const e of tree.entries) {
    console.log(`   ${e.type.padEnd(4)} ${e.path.padEnd(20)} ${e.size}b`);
  }

  console.log(`\n3. GET ${harnessUrl}/v1/sessions/${sessionId}/fs/file?path=greetings.md`);
  const fileText = await (await fetch(`${harnessUrl}/v1/sessions/${sessionId}/fs/file?path=greetings.md`)).text();
  console.log("   ----- begin file -----");
  console.log(fileText.split("\n").map((l) => `   ${l}`).join("\n"));
  console.log("   ----- end file -----");
} finally {
  console.log(`\n3. dispose() — tearing down the sandbox`);
  await agent.dispose();
  console.log("   ok");
}
