// Build the `agent_registry.source` object from a session_started payload.
//
// Ported verbatim from the Python SDK's AgentRegistrySink helpers
// (computer-agent-py/src/computeragent/telemetry/sinks/agentos.py) so the
// docs written by the HTTP ingest projection are byte-for-byte identical to
// what the now-removed Mongo sink wrote. The shapes are consumed by
// agent-defs.ts (`normalizeSource` / `hasResolvableSource`) and decide whether
// the SPA shows the "New chat" button (library = hidden, inline = shown).

export const DEFAULT_AGENT_INSTRUCTIONS =
  "You are a helpful assistant. Answer the user's question concisely and accurately.";

// GAP-style routing prefixes the GitAgentEngine uses to pick a backend; not
// real model ids. Strip them so `agent_registry.model` lands a bare id the
// Claude CLI (and every other model-id-only consumer) accepts.
const PROVIDER_PREFIXES = new Set(["anthropic", "openai", "bedrock", "lyzr", "vertex", "azure"]);

/** Strip a GAP provider prefix (`anthropic:claude-…` → `claude-…`). */
export function bareModelName(model: unknown): string | null {
  if (typeof model !== "string") return null;
  const idx = model.indexOf(":");
  if (idx < 0) return model;
  const prefix = model.slice(0, idx);
  if (PROVIDER_PREFIXES.has(prefix.toLowerCase())) return model.slice(idx + 1);
  return model;
}

type Payload = Record<string, unknown>;

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/**
 * `type: "library"` source for harness-mode agents (run in-process, no remote
 * HTTP harness to proxy to). The `type` deliberately does NOT match
 * git/local/inline so `hasResolvableSource` returns false and the chat-sandbox
 * button is hidden. The manifest block is preserved for the "Agent details" pane.
 */
export function librarySourceFor(
  name: string,
  payload: Payload,
  description = "",
): Record<string, unknown> {
  const model = bareModelName(payload["model"]);
  const manifest: Record<string, unknown> = { name, version: "0.1.0", description };
  if (model) manifest["model"] = model;
  return { type: "library", manifest, model };
}

/**
 * Complete inline IdentitySource the harness can clone into a sandbox workdir
 * for live chat. Captures the agent's options as `agent.yaml` + `CLAUDE.md`.
 * MCP servers / the Python-side cwd are deliberately omitted (don't translate
 * across processes/filesystems).
 */
export function inlineSourceFor(
  name: string,
  payload: Payload,
  description = "",
): Record<string, unknown> {
  const model = bareModelName(payload["model"]);
  const systemPrompt = str(payload["system_prompt"]) ?? DEFAULT_AGENT_INSTRUCTIONS;
  const allowedTools = Array.isArray(payload["allowed_tools"])
    ? (payload["allowed_tools"] as unknown[]).map((t) => String(t))
    : ["Read", "Glob", "Grep"];
  const maxTurns = typeof payload["max_turns"] === "number" ? (payload["max_turns"] as number) : null;
  const permissionMode = str(payload["permission_mode"]) ?? "bypassPermissions";

  const agentYaml = buildAgentYaml({
    name,
    model,
    allowedTools,
    maxTurns,
    permissionMode,
    description,
  });

  const manifest: Record<string, unknown> = { name, version: "0.1.0" };
  if (description) manifest["description"] = description;

  return {
    type: "inline",
    manifest,
    model,
    files: {
      "agent.yaml": agentYaml,
      "CLAUDE.md": systemPrompt,
    },
  };
}

/** Render the agent.yaml the harness's inline loader expects. */
export function buildAgentYaml(opts: {
  name: string;
  model: string | null;
  allowedTools: string[];
  maxTurns: number | null;
  permissionMode: string;
  description?: string;
}): string {
  const { name, model, allowedTools, maxTurns, permissionMode, description = "" } = opts;
  const lines = ['spec_version: "0.1.0"', `name: ${yamlStr(name)}`, "version: 0.1.0"];
  if (description) lines.push(`description: ${yamlStr(description)}`);
  if (model) lines.push("model:", `  preferred: ${yamlStr(model)}`);
  lines.push("runtime:");
  if (maxTurns !== null) lines.push(`  max_turns: ${Math.trunc(maxTurns)}`);
  lines.push(`  permission_mode: ${yamlStr(permissionMode)}`);
  if (allowedTools.length > 0) {
    lines.push("  allowed_tools:");
    for (const t of allowedTools) lines.push(`    - ${yamlStr(t)}`);
  }
  return lines.join("\n") + "\n";
}

/** Single-line YAML scalar — quote everything to dodge indicator chars. */
export function yamlStr(s: string): string {
  return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}
