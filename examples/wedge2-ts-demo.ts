/**
 * Wedge 2 demo — same flow as wedge1-fs-tour.sh, but driven through the
 * typed @computeragent/sdk client instead of curl.
 *
 * Demonstrates:
 *   - Constructor configures the agent (source, harness, options)
 *   - .chat() returns a ChatHandle that's both AsyncIterable (events) and
 *     PromiseLike (final result)
 *   - sessionId is reachable post-chat for FS endpoints
 *
 * Run with Bun, with the harness server already running on :7700:
 *   ANTHROPIC_API_KEY=sk-... bun run examples/wedge1-server.ts &
 *   ANTHROPIC_API_KEY=sk-... bun run examples/wedge2-ts-demo.ts
 */

import { ComputerAgent } from "@computeragent/sdk";

const HARNESS_URL = process.env.HARNESS_URL ?? "http://127.0.0.1:7700";
const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error("ANTHROPIC_API_KEY is not set");
  process.exit(1);
}

const agent = new ComputerAgent({
  source: {
    type: "inline",
    manifest: { name: "wedge2-writer", version: "0.1.0" },
    files: {
      "agent.yaml": [
        'spec_version: "0.1.0"',
        "name: wedge2-writer",
        "version: 0.1.0",
        "description: A writer agent for the Wedge 2 SDK demo",
        "model:",
        "  preferred: claude-sonnet-4-5-20250929",
        "runtime:",
        "  max_turns: 6",
      ].join("\n"),
      "SOUL.md": [
        "# Soul",
        "",
        "I am a minimal writer agent. When asked to produce a file, I:",
        "- Use the Write tool to create the file in the current working directory",
        "- Keep outputs short",
        "- Do not ask for confirmation",
      ].join("\n"),
    },
  },
  harness: "claude-agent-sdk",
  envs: { ANTHROPIC_API_KEY: apiKey },
  harnessUrl: HARNESS_URL,
  options: {
    permissionMode: "bypassPermissions",
    settingSources: ["project"],
  },
});

console.log("1. agent.chat(...)  — streaming events");
const handle = agent.chat(
  "Create a file named greetings.md containing exactly:\n\n" +
    "# Hello from the SDK\n\n" +
    "This file was written via @computeragent/sdk.\n\n" +
    'Then respond with just "done".',
);

let evCount = 0;
for await (const ev of handle) {
  evCount += 1;
  if (ev.kind === "ca_session_started") {
    console.log(`   [${evCount}] start sessionId=${ev.sessionId}`);
  } else if (ev.kind === "sdk_message") {
    const payload = ev.payload as { type?: string; result?: string; subtype?: string };
    if (payload.type === "result" && payload.result) {
      console.log(`   [${evCount}] sdk_message:result "${payload.result.slice(0, 60)}"`);
    } else if (payload.type === "system" && payload.subtype) {
      console.log(`   [${evCount}] sdk_message:system/${payload.subtype}`);
    }
  } else if (ev.kind === "ca_session_ended") {
    console.log(`   [${evCount}] end reason=${ev.reason}`);
  }
}
console.log(`   (total events: ${evCount})`);

const sessionId = await handle.sessionId();
console.log(`\n2. GET /v1/sessions/${sessionId}/fs/tree`);
const tree = await fetch(`${HARNESS_URL}/v1/sessions/${sessionId}/fs/tree?depth=1`).then((r) => r.json()) as {
  entries: { path: string; type: string; size: number }[];
};
for (const entry of tree.entries) {
  console.log(`   ${entry.type.padEnd(4)} ${entry.path.padEnd(20)} ${entry.size}b`);
}

console.log(`\n3. GET /v1/sessions/${sessionId}/fs/file?path=greetings.md`);
const fileText = await fetch(`${HARNESS_URL}/v1/sessions/${sessionId}/fs/file?path=greetings.md`).then((r) => r.text());
console.log("   ----- begin file -----");
console.log(fileText.split("\n").map((l) => `   ${l}`).join("\n"));
console.log("   ----- end file -----");

console.log(`\n4. DELETE /v1/sessions/${sessionId}`);
await fetch(`${HARNESS_URL}/v1/sessions/${sessionId}`, { method: "DELETE" });
console.log("   ok");
