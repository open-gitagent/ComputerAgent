/**
 * ComputerAgentServer — boot the server, run an agent via HTTP, tear down.
 *
 *   ANTHROPIC_API_KEY=sk-ant-... bun run examples/server-demo.ts
 *
 * Shows the full server flow in ~50 lines: spin up an HTTP server on
 * localhost, POST a full agent config to /run, stream the SSE response,
 * print the haiku the agent wrote. Same agent that hello.ts uses — only
 * the transport changes (in-process call vs HTTP). The point: any client
 * (curl, Python, browser) can drive an agent through this surface.
 */
import { ComputerAgentServer } from "./computeragent-server.ts";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) throw new Error("Set ANTHROPIC_API_KEY first.");

const port = 8800 + Math.floor(Math.random() * 200);
const server = new ComputerAgentServer({
  host: "127.0.0.1",
  port,
  defaultEnvs: { ANTHROPIC_API_KEY },
  maxConcurrentRuns: 2,
});
await server.listen();
const base = `http://127.0.0.1:${port}`;
console.log(`server listening on ${base}\n`);

try {
  // Same agent hello.ts uses — inline, claude-agent-sdk, haiku.
  const res = await fetch(`${base}/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      source: {
        type: "inline",
        manifest: { name: "haiku-bot", version: "0.1.0" },
      },
      harness: "claude-agent-sdk",
      options: { permissionMode: "bypassPermissions" },
      model: "claude-haiku-4-5-20251001",
      message: 'Write a 3-line haiku about TypeScript to "haiku.txt". Use the Write tool.',
    }),
  });
  if (!res.ok || !res.body) throw new Error(`POST /run failed: ${res.status} ${await res.text()}`);

  let sessionId = "";
  let haiku = "";
  let usage: { inputTokens?: number; outputTokens?: number; costUsd?: number } | undefined;

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
      const data = JSON.parse(dataMatch[1]);
      if (evMatch[1] === "ca_session_started") {
        sessionId = data.sessionId;
        // Fetch the file while the session is still live — once ca_session_ended
        // fires, the agent disposes and the workdir is gone.
        // (We poll on tool_result below; for now just record the id.)
      } else if (evMatch[1] === "sdk_message" && data.payload?.type === "user") {
        // Tool results arrive as type:"user" with content[].type:"tool_result"
        // After the first tool_result we can fetch the artifact.
        if (!haiku && sessionId) {
          const file = await fetch(`${base}/artifact?sessionId=${sessionId}&path=haiku.txt`);
          if (file.ok) haiku = await file.text();
        }
      } else if (evMatch[1] === "ca_usage_snapshot") {
        usage = data;
      }
    }
  }

  console.log(haiku ? `\n${haiku}\n` : "(no file produced)\n");
  console.log(
    `${(usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0)} tokens • ` +
      `$${usage?.costUsd?.toFixed(4) ?? "?"} • ` +
      `session ${sessionId}`,
  );
} finally {
  await server.close();
}
