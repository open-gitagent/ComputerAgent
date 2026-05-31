/**
 * Wedge 1.6 — Mongo SessionStore live demo.
 *
 * Same shape as wedge16-resume-demo.ts (file-store version), but the store
 * is plugged in at server boot via the registry:
 *
 *   createHarnessServer({
 *     sessionStores: { mongo: (cfg) => new MongoSessionStore(cfg) },
 *   })
 *
 * Two invocations:
 *
 *   ANTHROPIC_API_KEY=... MONGO_URL=mongodb://... bun examples/wedge16-mongo-resume-demo.ts
 *   ANTHROPIC_API_KEY=... MONGO_URL=mongodb://... bun examples/wedge16-mongo-resume-demo.ts continue
 *
 * The first invocation tells the agent to remember a number; the JSONL turn
 * entries land in MongoDB's `computeragent_sessions.sessions` collection.
 * The second invocation (fresh process, fresh harness) loads those entries
 * via store.load() and asks the agent to recall the number.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ComputerAgent } from "@open-gitagent/sdk";
import { createHarnessServer } from "@computeragent/harness-server";
import { ClaudeAgentEngine } from "@computeragent/engine-claude-agent-sdk";
import { GitAgentProtocolLoader } from "@computeragent/identity-gitagentprotocol";
import { MongoSessionStore } from "@open-gitagent/session-store-mongo";

const anthropicKey = process.env.ANTHROPIC_API_KEY;
const mongoUrl = process.env.MONGO_URL;
if (!anthropicKey) { console.error("ANTHROPIC_API_KEY must be set"); process.exit(1); }
if (!mongoUrl) { console.error("MONGO_URL must be set"); process.exit(1); }

const SESSIONS_DIR = join(import.meta.dir ?? __dirname, "wedge16-mongo-sessions");
const SESSION_ID_FILE = join(SESSIONS_DIR, ".last-session-id");

const mode: "first" | "continue" =
  process.argv[2] === "continue" ? "continue" : "first";

async function bootServer(): Promise<{ url: string; stop: () => Promise<void> }> {
  const { serve } = await import("@hono/node-server");
  // The MongoSessionStore is constructed by a builder in the registry — same
  // shape used for engines / identityLoaders / built-in stores. The builder
  // receives the `options` field from the wire-side SessionStoreConfig.
  // Custom backends plug in here without touching the framework.
  const app = createHarnessServer({
    engines: { "claude-agent-sdk": new ClaudeAgentEngine() },
    identityLoaders: { gitagentprotocol: new GitAgentProtocolLoader() },
    sessionStores: {
      mongo: (options) => {
        const opts = (options ?? {}) as { url?: string; database?: string };
        return new MongoSessionStore({
          url: opts.url ?? mongoUrl!,
          database: opts.database ?? "computeragent_sessions",
        });
      },
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
    try {
      priorSessionId = (await readFile(SESSION_ID_FILE, "utf8")).trim();
    } catch {
      console.error("[demo] no prior session id found — falling back to 'first'");
    }
  }

  const agent = new ComputerAgent({
    source: {
      type: "inline",
      manifest: { name: "wedge16-mongo-memory", version: "0.1.0" },
      files: {
        "agent.yaml": [
          'spec_version: "0.1.0"',
          "name: wedge16-mongo-memory",
          "version: 0.1.0",
          "description: Mongo-backed cross-process session memory demo",
          "model:",
          "  preferred: claude-haiku-4-5-20251001",
          "runtime:",
          "  max_turns: 4",
        ].join("\n"),
        "SOUL.md": [
          "# Soul",
          "",
          "Respond in one short sentence. Do not call tools.",
          "If the user asks to remember something, acknowledge it.",
          "If asked to recall, answer directly with the remembered fact.",
        ].join("\n"),
      },
    },
    harness: "claude-agent-sdk",
    harnessUrl: handle.url,
    envs: { ANTHROPIC_API_KEY: anthropicKey },
    options: { permissionMode: "bypassPermissions", settingSources: ["project"] },
    // The wire-side descriptor that the server resolves via the registry.
    // No "url" override here — the server-side builder defaults to MONGO_URL,
    // so the URL never crosses the wire. Production deployments should keep
    // credentials server-side and have clients send `{ kind: "mongo" }` only.
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

    let lastText = "";
    for await (const ev of agent.chat(message)) {
      if (ev.kind === "ca_session_started") {
        console.error(`[demo] session started: ${ev.sessionId}`);
        await writeFile(SESSION_ID_FILE, ev.sessionId, "utf8");
      } else if (ev.kind === "sdk_message") {
        const p = ev.payload as { type?: string; result?: string };
        if (p.type === "result" && p.result) lastText = p.result;
      } else if (ev.kind === "ca_session_ended") {
        console.error(
          `[demo] session ended: ${ev.reason}${ev.errorMessage ? `  error=${ev.errorMessage}` : ""}`,
        );
      }
    }

    console.log(`\nA: ${lastText}\n`);
    if (mode === "continue") {
      const ok = /47/.test(lastText);
      console.log(ok ? "PASS — recalled '47' from MongoDB" : "FAIL — '47' not present");
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
