/**
 * GAP sub-agents translator. Reads `agents/` from a GAP repo and produces the
 * Claude Agent SDK's `agents: Record<string, AgentDefinition>` map.
 *
 * Two on-disk layouts are honored:
 *
 *   agents/<name>/agent.yaml + agents/<name>/SOUL.md
 *     — full nested GAP repo. Manifest fields (model, runtime) translate the
 *       same way the top-level adapter handles them. SOUL.md becomes the
 *       sub-agent's prompt.
 *
 *   agents/<name>.yaml
 *     — inline single-file form. Schema:
 *         description: <required>
 *         prompt: <required — the sub-agent's system prompt>
 *         model?: <model alias or id>
 *         tools?: [<built-in or mcp__... tool names>]
 *         disallowed_tools?: [...]
 *
 * Sub-agent name is derived from the directory/file basename.
 *
 * Out of scope: deeper nesting (sub-sub-agents), tools/ inside an agents/<n>/
 * directory (script tools for a sub-agent), per-sub-agent compliance blocks.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { AgentDefinition } from "@anthropic-ai/claude-agent-sdk";

const InlineSubagent = z
  .object({
    description: z.string().min(1),
    prompt: z.string().min(1),
    model: z.string().optional(),
    tools: z.array(z.string()).optional(),
    disallowed_tools: z.array(z.string()).optional(),
  })
  .passthrough();

const NestedSubagentManifest = z
  .object({
    name: z.string().optional(),
    version: z.string().optional(),
    description: z.string().optional(),
    model: z.object({ preferred: z.string().optional() }).passthrough().optional(),
    tools: z.array(z.string()).optional(),
  })
  .passthrough();

export async function loadGapSubagents(workdir: string): Promise<Record<string, AgentDefinition>> {
  const dir = join(workdir, "agents");
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return {};
  }

  const out: Record<string, AgentDefinition> = {};

  for (const entry of entries) {
    const abs = join(dir, entry);
    const info = await safeStat(abs);
    if (!info) continue;

    if (info.isDirectory()) {
      const def = await loadNestedSubagent(abs);
      if (def) out[entry] = def;
    } else if (info.isFile() && (entry.endsWith(".yaml") || entry.endsWith(".yml"))) {
      const name = entry.replace(/\.ya?ml$/, "");
      const def = await loadInlineSubagent(abs);
      if (def) out[name] = def;
    }
  }

  return out;
}

async function loadInlineSubagent(path: string): Promise<AgentDefinition | null> {
  const raw = await readFileSafe(path);
  if (raw === null) return null;
  let yaml: unknown;
  try { yaml = parseYaml(raw); } catch { return null; }
  const parsed = InlineSubagent.safeParse(yaml);
  if (!parsed.success) return null;
  const def: AgentDefinition = {
    description: parsed.data.description,
    prompt: parsed.data.prompt,
  };
  if (parsed.data.model) def.model = parsed.data.model;
  if (parsed.data.tools) def.tools = parsed.data.tools;
  if (parsed.data.disallowed_tools) def.disallowedTools = parsed.data.disallowed_tools;
  return def;
}

async function loadNestedSubagent(dir: string): Promise<AgentDefinition | null> {
  const manifestRaw = await readFileSafe(join(dir, "agent.yaml"));
  const soul = await readFileSafe(join(dir, "SOUL.md"));
  // A sub-agent needs at minimum a prompt (SOUL.md) and a description.
  if (!soul) return null;

  let description = "Sub-agent";
  let model: string | undefined;
  let tools: string[] | undefined;

  if (manifestRaw) {
    let yaml: unknown;
    try { yaml = parseYaml(manifestRaw); } catch { yaml = undefined; }
    const parsed = NestedSubagentManifest.safeParse(yaml);
    if (parsed.success) {
      if (parsed.data.description) description = parsed.data.description;
      if (parsed.data.model?.preferred) model = parsed.data.model.preferred;
      if (parsed.data.tools) tools = parsed.data.tools;
    }
  }

  const def: AgentDefinition = {
    description,
    prompt: soul.trim(),
  };
  if (model) def.model = model;
  if (tools) def.tools = tools;
  return def;
}

async function safeStat(path: string): Promise<import("node:fs").Stats | null> {
  try { return await stat(path); } catch { return null; }
}

async function readFileSafe(path: string): Promise<string | null> {
  try { return await readFile(path, "utf8"); } catch { return null; }
}
