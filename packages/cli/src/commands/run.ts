import { defineCommand } from "citty";
import { ComputerAgent, type IdentitySource } from "@open-gitagent/sdk";
import { renderEventLine } from "../output.js";

const DEFAULT_HARNESS_URL = "http://127.0.0.1:7700";

/**
 * `computeragent run <source> --message "..." [flags]`
 *
 * Streams the agent's events to stdout, one line per significant event.
 * Pretty-prints engine messages and ends with the final result.
 */
export const runCommand = defineCommand({
  meta: {
    name: "run",
    description: "Run an agent against a harness server, streaming events to stdout.",
  },
  args: {
    source: {
      type: "positional",
      required: true,
      description: "GAP source: github URL, local path, or 'inline:{json}'",
    },
    message: {
      type: "string",
      alias: "m",
      description: "Initial user message",
      required: true,
    },
    harness: {
      type: "string",
      alias: "h",
      description: "Engine name registered on the harness server",
      default: "claude-agent-sdk",
    },
    loader: {
      type: "string",
      description: "Identity loader name",
      default: "gitagentprotocol",
    },
    "harness-url": {
      type: "string",
      description: "Harness server URL",
      default: DEFAULT_HARNESS_URL,
    },
    "permission-mode": {
      type: "string",
      description: "Engine permission mode (e.g. bypassPermissions, default)",
      default: "default",
    },
    "max-turns": {
      type: "string",
      description: "Maximum agent loop iterations",
    },
    "raw": {
      type: "boolean",
      description: "Emit raw JSON events (one per line) instead of pretty lines",
    },
  },
  async run({ args }) {
    const source = parseSource(args.source);
    const envs = collectEnvs();
    const options: Record<string, unknown> = {
      permissionMode: args["permission-mode"],
      settingSources: ["project"],
    };
    if (args["max-turns"]) options.maxTurns = Number(args["max-turns"]);

    const agent = new ComputerAgent({
      source,
      harness: args.harness,
      identityLoader: args.loader,
      harnessUrl: args["harness-url"],
      envs,
      options,
    });

    const handle = agent.chat(args.message);
    let exitCode = 0;
    for await (const ev of handle) {
      if (args.raw) {
        process.stdout.write(`${JSON.stringify(ev)}\n`);
        continue;
      }
      const line = renderEventLine(ev);
      if (line) process.stdout.write(`${line}\n`);
      if (ev.kind === "ca_session_ended" && ev.reason !== "complete") exitCode = 1;
    }
    process.exit(exitCode);
  },
});

/**
 * Parse the positional source arg into an IdentitySource.
 *   github.com/x/y          → { type: "git", url }
 *   /abs/path or ./relative → { type: "local", path }
 *   inline:{json}           → { type: "inline", ... }
 */
function parseSource(raw: string): IdentitySource {
  if (raw.startsWith("inline:")) {
    const json = raw.slice("inline:".length);
    const obj = JSON.parse(json) as { manifest: Record<string, unknown>; files?: Record<string, string> };
    return { type: "inline", manifest: obj.manifest, ...(obj.files ? { files: obj.files } : {}) };
  }
  if (raw.startsWith("/") || raw.startsWith("./") || raw.startsWith("../")) {
    return { type: "local", path: raw };
  }
  return { type: "git", url: raw };
}

/**
 * Collect env vars to forward to the engine. Filters to the common set agents
 * actually need; we don't blindly leak the entire process env onto the wire.
 */
function collectEnvs(): Record<string, string> {
  const allowed = [
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "GEMINI_API_KEY",
    "GROQ_API_KEY",
    "DEEPSEEK_API_KEY",
    "GITHUB_TOKEN",
    "GIT_TOKEN",
  ];
  const out: Record<string, string> = {};
  for (const k of allowed) {
    const v = process.env[k];
    if (v) out[k] = v;
  }
  return out;
}
