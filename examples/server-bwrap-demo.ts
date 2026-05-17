/**
 * Same shape as server-demo.ts but with `BwrapSubstrate` — each agent
 * request runs in its own namespace-isolated bwrap sandbox.
 *
 *   ANTHROPIC_API_KEY=sk-ant-... bun run examples/server-bwrap-demo.ts
 *
 * Linux-only. Requires `bwrap` on PATH (apt install bubblewrap / dnf install
 * bubblewrap). On macOS the substrate fails fast with a clear error — use
 * server-demo.ts (LocalSubstrate) for dev there.
 *
 * Also runs an isolation probe at the end: asks the agent to inspect its
 * own /, /etc/passwd, ~/.ssh — under bwrap the agent should see only the
 * sandboxed view, not your host's real files.
 */
import { ComputerAgentServer } from "./computeragent-server.ts";
import { BwrapSubstrate } from "@computeragent/runtime-bwrap";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) throw new Error("Set ANTHROPIC_API_KEY first.");

const port = 8800 + Math.floor(Math.random() * 200);
const server = new ComputerAgentServer({
  host: "127.0.0.1",
  port,
  defaultEnvs: { ANTHROPIC_API_KEY },
  maxConcurrentRuns: 4,
  // The one-line swap: every /run gets a fresh BwrapSubstrate, which
  // namespace-isolates the spawned harness child.
  substrate: () => new BwrapSubstrate(),
});
await server.listen();
const base = `http://127.0.0.1:${port}`;
console.log(`server listening on ${base} (BwrapSubstrate)\n`);

try {
  const res = await fetch(`${base}/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      source: {
        type: "inline",
        manifest: { name: "bwrap-probe", version: "0.0.1" },
      },
      harness: "claude-agent-sdk",
      options: { permissionMode: "bypassPermissions" },
      model: "claude-haiku-4-5-20251001",
      message: [
        "Run each of these shell commands via the Bash tool and report",
        "exactly what each prints. Don't editorialize.",
        "",
        "  cmd1: ls / | sort",
        "  cmd2: cat /etc/passwd 2>&1 | head -2",
        "  cmd3: cat $HOME/.ssh/id_rsa 2>&1 | head -2",
        "  cmd4: id",
        "",
        "Then say done.",
      ].join("\n"),
    }),
  });
  if (!res.ok || !res.body) throw new Error(`POST /run failed: ${res.status} ${await res.text()}`);

  let lastText = "";
  let toolUses = 0;
  let serverError: string | undefined;
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += value;
    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const evMatch = frame.match(/^event: (.+)$/m);
      const dataMatch = frame.match(/^data: (.+)$/m);
      if (!evMatch || !dataMatch) continue;
      const ev = evMatch[1];
      const data = JSON.parse(dataMatch[1]);
      if (ev === "sdk_message" && data.payload?.type === "assistant") {
        for (const b of data.payload.message?.content ?? []) {
          if (b.type === "tool_use") toolUses++;
          if (b.type === "text" && typeof b.text === "string") lastText = b.text;
        }
      } else if (ev === "sdk_message" && data.payload?.type === "result") {
        lastText = data.payload.result ?? lastText;
      } else if (ev === "ca_error" || ev === "ca_session_ended") {
        // ComputerAgentServer emits ca_error on substrate boot failure; the
        // harness emits ca_session_ended with reason="error" on engine error.
        const msg = data.message ?? data.errorMessage;
        if (msg) serverError = msg;
      }
    }
  }

  if (serverError) {
    console.log("\nserver returned an error:");
    console.log(`  ${serverError}`);
    console.log("\nIf you're on macOS, this is expected — bwrap is Linux-only.");
    console.log("Use examples/server-demo.ts (LocalSubstrate) for dev on this OS.");
  } else {
    console.log("\n── agent's view of the sandbox ─────────────────────────");
    console.log(lastText || "(no text returned)");
    console.log("────────────────────────────────────────────────────────");
    console.log(`\n${toolUses} tool calls.`);
    console.log("Expected: cmd1 shows only bin/lib/usr/workdir/proc/dev/tmp/...");
    console.log("          cmd2 fails or shows only the sandboxed view");
    console.log("          cmd3 fails (HOME is the workdir, not your host home)");
    console.log("          cmd4 shows uid 0 inside the namespace (mapped from host)");
  }
} finally {
  await server.close();
}
