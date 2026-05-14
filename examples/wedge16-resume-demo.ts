/**
 * Wedge 1.6 demo — conversation continuation via a swappable file SessionStore.
 *
 * Run twice in two separate invocations to prove cross-process resume:
 *
 *   ANTHROPIC_API_KEY=sk-... bun run examples/wedge16-resume-demo.ts
 *   ANTHROPIC_API_KEY=sk-... bun run examples/wedge16-resume-demo.ts continue
 *
 * The first invocation tells the agent "remember the number 47". The second
 * invocation (a fresh process, fresh harness) asks the agent what number it
 * was told — and the response should contain "47", proving the file store
 * carried the conversation across the process boundary.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ComputerAgent } from "@computeragent/sdk";
import { createHarnessServer } from "@computeragent/harness-server";
import { ClaudeAgentEngine } from "@computeragent/engine-claude-agent-sdk";
import { GitAgentProtocolLoader } from "@computeragent/identity-gitagentprotocol";

const anthropicKey = process.env.ANTHROPIC_API_KEY;
if (!anthropicKey) {
  console.error("ANTHROPIC_API_KEY must be set");
  process.exit(1);
}

const SESSIONS_DIR = join(import.meta.dir ?? __dirname, "wedge16-sessions");
const SESSION_ID_FILE = join(SESSIONS_DIR, ".last-session-id");

const mode: "first" | "continue" =
  process.argv[2] === "continue" ? "continue" : "first";

async function bootServer(): Promise<{ url: string; stop: () => void }> {
  const { serve } = await import("@hono/node-server");
  const app = createHarnessServer({
    engines: { "claude-agent-sdk": new ClaudeAgentEngine() },
    identityLoaders: { gitagentprotocol: new GitAgentProtocolLoader() },
  });
  return new Promise((resolve) => {
    const server = serve({ fetch: app.fetch, port: 0 }, ({ port }) => {
      resolve({
        url: `http://127.0.0.1:${port}`,
        stop: () => server.close(),
      });
    });
  });
}

async function main(): Promise<void> {
  await mkdir(SESSIONS_DIR, { recursive: true });
  const handle = await bootServer();
  console.error(`[demo] harness at ${handle.url}`);

  let priorSessionId: string | undefined;
  if (mode === "continue") {
    try {
      priorSessionId = (await readFile(SESSION_ID_FILE, "utf8")).trim();
    } catch {
      console.error("[demo] no prior session id found — running 'first' instead");
    }
  }

  const agent = new ComputerAgent({
    source: {
      type: "inline",
      manifest: { name: "wedge16-memory-demo", version: "0.1.0" },
      files: {
        "agent.yaml": [
          'spec_version: "0.1.0"',
          "name: wedge16-memory-demo",
          "version: 0.1.0",
          "description: Demonstrates session-store-backed memory",
          "model:",
          "  preferred: claude-haiku-4-5-20251001",
          "runtime:",
          "  max_turns: 4",
        ].join("\n"),
        "SOUL.md": [
          "# Soul",
          "",
          "Respond in one short sentence. Do not call any tools.",
          "If the user asks you to remember something, acknowledge it.",
          "If asked to recall, answer directly with the remembered fact.",
        ].join("\n"),
      },
    },
    harness: "claude-agent-sdk",
    harnessUrl: handle.url,
    envs: { ANTHROPIC_API_KEY: anthropicKey },
    options: { permissionMode: "bypassPermissions", settingSources: ["project"] },
    sessionStore: { kind: "file", options: { root: SESSIONS_DIR } },
    ...(priorSessionId ? { sessionId: priorSessionId } : {}),
  });

  try {
    const message =
      mode === "first"
        ? "Please remember this for later: the number is 47."
        : "What number did I ask you to remember?";

    console.error(`[demo] mode=${mode} sessionId=${priorSessionId ?? "(fresh)"}`);
    console.error(`[demo] user: ${message}`);

    let lastText = "";
    for await (const ev of agent.chat(message)) {
      if (ev.kind === "ca_session_started") {
        console.error(`[demo] session started: ${ev.sessionId}`);
        await writeFile(SESSION_ID_FILE, ev.sessionId, "utf8");
      } else if (ev.kind === "sdk_message") {
        const p = ev.payload as { type?: string; message?: { content?: unknown[] }; result?: string };
        if (p.type === "result" && p.result) {
          lastText = p.result;
        }
      } else if (ev.kind === "ca_session_ended") {
        console.error(`[demo] session ended: ${ev.reason}${ev.errorMessage ? `  error=${ev.errorMessage}` : ""}`);
      }
    }

    console.log(`\nassistant: ${lastText}\n`);
    if (mode === "continue") {
      const ok = /47/.test(lastText);
      console.log(ok ? "PASS — the agent recalled '47' from the prior turn" : "FAIL — '47' not present in response");
      process.exit(ok ? 0 : 1);
    } else {
      console.log("Next: run again with the 'continue' argument to test resume.");
    }
  } finally {
    await agent.dispose();
    handle.stop();
  }
}

await main();
