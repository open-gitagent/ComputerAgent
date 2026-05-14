/**
 * Wedge 1.6 — gitagent + MongoDB cross-process resume.
 *
 * Same shape as the Claude demo, but `harness: "gitagent"`. Gitclaw has no
 * native sessionStore parameter; the engine driver synthesizes resume by
 * loading prior turns from the store and injecting them as systemPromptSuffix,
 * then writing each new exchange back. See
 * `packages/engine-gitagent/src/session-replay.ts`.
 *
 * Run twice:
 *   ANTHROPIC_API_KEY=... MONGO_URL=mongodb://... bun examples/wedge16-gitagent-mongo-demo.ts
 *   ANTHROPIC_API_KEY=... MONGO_URL=mongodb://... bun examples/wedge16-gitagent-mongo-demo.ts continue
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ComputerAgent } from "@computeragent/sdk";
import { createHarnessServer } from "@computeragent/harness-server";
import { GitAgentEngine } from "@computeragent/engine-gitagent";
import { GitAgentProtocolLoader } from "@computeragent/identity-gitagentprotocol";
import { MongoSessionStore } from "@computeragent/session-store-mongo";

const anthropicKey = process.env.ANTHROPIC_API_KEY;
const mongoUrl = process.env.MONGO_URL;
if (!anthropicKey) { console.error("ANTHROPIC_API_KEY must be set"); process.exit(1); }
if (!mongoUrl) { console.error("MONGO_URL must be set"); process.exit(1); }
process.env.ANTHROPIC_API_KEY = anthropicKey;

const SESSIONS_DIR = join(import.meta.dir ?? __dirname, "wedge16-gitagent-sessions");
const SESSION_ID_FILE = join(SESSIONS_DIR, ".last-session-id");

const mode: "first" | "continue" =
  process.argv[2] === "continue" ? "continue" : "first";

async function bootServer(): Promise<{ url: string; stop: () => Promise<void> }> {
  const { serve } = await import("@hono/node-server");
  const app = createHarnessServer({
    engines: { gitagent: new GitAgentEngine() },
    identityLoaders: { gitagentprotocol: new GitAgentProtocolLoader() },
    sessionStores: {
      mongo: (options) => new MongoSessionStore({
        url: ((options as { url?: string })?.url) ?? mongoUrl!,
        database: "computeragent_sessions",
      }),
    },
  });
  return new Promise((resolve) => {
    const server = serve({ fetch: app.fetch, port: 0 }, ({ port }) => {
      resolve({
        url: `http://127.0.0.1:${port}`,
        stop: async () => { server.close(); },
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
    try { priorSessionId = (await readFile(SESSION_ID_FILE, "utf8")).trim(); }
    catch { console.error("[demo] no prior session id — running 'first' instead"); }
  }

  const agent = new ComputerAgent({
    source: {
      type: "inline",
      manifest: { name: "wedge16-gitagent-memory", version: "0.1.0" },
      files: {
        "agent.yaml": [
          'spec_version: "0.1.0"',
          "name: wedge16-gitagent-memory",
          "version: 0.1.0",
          "description: gitagent + Mongo cross-process memory demo",
          "model:",
          "  preferred: anthropic:claude-haiku-4-5-20251001",
          "runtime:",
          "  max_turns: 3",
        ].join("\n"),
        "SOUL.md": [
          "# Soul",
          "",
          "Respond in one short sentence. Do not call tools.",
          "If the user asks you to remember something, acknowledge it.",
          "If asked to recall and the conversation history (above) contains the fact, answer directly with that fact.",
        ].join("\n"),
      },
    },
    harness: "gitagent",
    harnessUrl: handle.url,
    envs: { ANTHROPIC_API_KEY: anthropicKey },
    sessionStore: { kind: "mongo" },
    ...(priorSessionId ? { sessionId: priorSessionId } : {}),
  });

  try {
    const message =
      mode === "first"
        ? "Please remember this for later: the number is 47."
        : "What number did I ask you to remember?";

    console.error(`[demo] mode=${mode} sessionId=${priorSessionId ?? "(fresh)"}`);
    console.error(`[demo] user: ${message}`);

    let assistantTexts: string[] = [];
    for await (const ev of agent.chat(message)) {
      if (ev.kind === "ca_session_started") {
        console.error(`[demo] session started: ${ev.sessionId}`);
        await writeFile(SESSION_ID_FILE, ev.sessionId, "utf8");
      } else if (ev.kind === "sdk_message") {
        const p = ev.payload as { type?: string; content?: string };
        if (p.type === "assistant" && typeof p.content === "string") {
          assistantTexts.push(p.content);
        }
      } else if (ev.kind === "ca_session_ended") {
        console.error(
          `[demo] session ended: ${ev.reason}${ev.errorMessage ? `  error=${ev.errorMessage}` : ""}`,
        );
      }
    }

    const lastText = assistantTexts.join(" ").trim();
    console.log(`\nA: ${lastText}\n`);
    if (mode === "continue") {
      const ok = /47/.test(lastText);
      console.log(ok ? "PASS — gitagent recalled '47' from MongoDB" : "FAIL — '47' not present");
      process.exit(ok ? 0 : 1);
    } else {
      console.log("Next: re-run with the 'continue' argument to test resume.");
    }
  } finally {
    await agent.dispose();
    await handle.stop();
  }
}

await main();
