/**
 * Local gitagent test — same flow as wedge3-e2b-gitagent.ts but the harness
 * runs on localhost (wedge1-server.ts). Used to isolate whether gitclaw write-tool
 * bugs are E2B-specific or also reproduce locally.
 */

import { ComputerAgent } from "@computeragent/sdk";

const anthropicKey = process.env.ANTHROPIC_API_KEY;
if (!anthropicKey) {
  console.error("ANTHROPIC_API_KEY must be set");
  process.exit(1);
}

const agent = new ComputerAgent({
  source: {
    type: "inline",
    manifest: { name: "wedge2-gitagent-writer", version: "0.1.0" },
    files: {
      "agent.yaml": [
        'spec_version: "0.1.0"',
        "name: wedge2-gitagent-writer",
        "version: 0.1.0",
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
  options: {
    model: "anthropic:claude-sonnet-4-5-20250929",
    maxTurns: 6,
  },
});

try {
  console.log("agent.chat(...)  — gitagent engine on localhost");
  const handle = agent.chat(
    "Create a file named gitagent-hello.md containing exactly:\n\n" +
      "# Hello from gitagent\n\n" +
      "Then respond with just \"done\".",
  );

  for await (const ev of handle) {
    if (ev.kind === "ca_session_started") {
      console.log(`   [start] sessionId=${ev.sessionId}, engine=${ev.engine}`);
    } else if (ev.kind === "sdk_message") {
      const p = ev.payload as {
        type?: string;
        content?: string;
        toolName?: string;
        toolCallId?: string;
        isError?: boolean;
        subtype?: string;
      };
      if (p.type === "assistant" && typeof p.content === "string") {
        console.log(`   [assistant] ${p.content.slice(0, 150)}`);
      } else if (p.type === "tool_use") {
        const args = (ev.payload as { args?: unknown }).args;
        console.log(`   [tool_use] ${p.toolName}  args=${JSON.stringify(args).slice(0, 200)}`);
      } else if (p.type === "tool_result") {
        console.log(`   [tool_result] callId=${p.toolCallId} isError=${p.isError}  content=${(p.content ?? "").slice(0, 200)}`);
      } else if (p.type === "system") {
        console.log(`   [system] ${p.subtype}: ${(p.content ?? "").slice(0, 100)}`);
      }
    } else if (ev.kind === "ca_session_ended") {
      console.log(`   [end] reason=${ev.reason}${ev.errorMessage ? `  error=${ev.errorMessage}` : ""}`);
    }
  }

  const sessionId = await handle.sessionId();
  const harnessUrl = await agent.harnessUrl();

  console.log(`\nfs/tree:`);
  const tree = (await (await fetch(`${harnessUrl}/v1/sessions/${sessionId}/fs/tree?depth=2`)).json()) as {
    entries: { path: string; type: string; size: number }[];
  };
  for (const e of tree.entries) {
    console.log(`   ${e.type.padEnd(4)} ${e.path.padEnd(40)} ${e.size}b`);
  }

  console.log(`\nfs/file gitagent-hello.md:`);
  const file = await (
    await fetch(`${harnessUrl}/v1/sessions/${sessionId}/fs/file?path=gitagent-hello.md`)
  ).text();
  console.log(file.split("\n").map((l) => `   ${l}`).join("\n"));
} finally {
  await agent.dispose();
}
