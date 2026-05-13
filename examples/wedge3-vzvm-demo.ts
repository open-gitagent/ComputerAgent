/**
 * Wedge 3a-followup demo — same fs-tour flow but the harness server runs inside
 * a Linux VM on Apple's Virtualization framework, managed via Tart.
 *
 * Prereqs:
 *   brew install cirruslabs/cli/tart
 *   tart pull ghcr.io/cirruslabs/ubuntu:latest
 *
 * Run:
 *   ANTHROPIC_API_KEY=sk-ant-... bun run examples/wedge3-vzvm-demo.ts
 */

import { ComputerAgent } from "@computeragent/sdk";
import { VZVMSubstrate } from "@computeragent/runtime-vzvm";

const anthropicKey = process.env.ANTHROPIC_API_KEY;
if (!anthropicKey) {
  console.error("ANTHROPIC_API_KEY must be set");
  process.exit(1);
}

const agent = new ComputerAgent({
  source: {
    type: "inline",
    manifest: { name: "wedge3-vzvm-writer", version: "0.1.0" },
    files: {
      "agent.yaml": [
        'spec_version: "0.1.0"',
        "name: wedge3-vzvm-writer",
        "version: 0.1.0",
        "description: Writer agent for the Wedge 3a (VZ VM substrate) demo",
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
  runtime: new VZVMSubstrate({
    baseImage: "ghcr.io/cirruslabs/ubuntu:latest",
    sshUser: "admin",
    sshPassword: "admin",
    onLog: (line) => process.stderr.write(`[vzvm] ${line}\n`),
  }),
  options: {
    permissionMode: "bypassPermissions",
    settingSources: ["project"],
  },
});

try {
  console.log("1. agent.chat(...)  — substrate boots a VZ VM on first call");
  const handle = agent.chat(
    "Create a file named vm-hello.md containing exactly:\n\n" +
      "# Hello from a Linux VM\n\n" +
      "This file was written by an agent running in a VZVirtualMachine on macOS.\n\n" +
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

  console.log(`\n2. GET ${harnessUrl}/v1/sessions/${sessionId}/fs/tree`);
  const tree = (await (await fetch(`${harnessUrl}/v1/sessions/${sessionId}/fs/tree?depth=1`)).json()) as {
    entries: { path: string; type: string; size: number }[];
  };
  for (const e of tree.entries) {
    console.log(`   ${e.type.padEnd(4)} ${e.path.padEnd(28)} ${e.size}b`);
  }

  console.log(`\n3. GET ${harnessUrl}/v1/sessions/${sessionId}/fs/file?path=vm-hello.md`);
  const fileText = await (
    await fetch(`${harnessUrl}/v1/sessions/${sessionId}/fs/file?path=vm-hello.md`)
  ).text();
  console.log("   ----- begin file -----");
  console.log(fileText.split("\n").map((l) => `   ${l}`).join("\n"));
  console.log("   ----- end file -----");
} finally {
  console.log(`\n4. dispose() — stopping + deleting the VM`);
  await agent.dispose();
  console.log("   ok");
}
