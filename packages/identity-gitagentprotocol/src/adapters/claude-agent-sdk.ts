import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ClaudeAgentOptions } from "@computeragent/protocol";
import type { GapManifest } from "../manifest.js";

/**
 * GAP → Claude Agent SDK options translator. Pure-ish: side effects limited to
 * reading docs files (SOUL.md, RULES.md, AGENTS.md) from the workdir.
 *
 * Minimal MVP mapping:
 *   agent.yaml.model.preferred          → model
 *   agent.yaml.runtime.max_turns        → maxTurns
 *   agent.yaml.runtime.budget_usd       → maxBudgetUsd
 *   SOUL.md + RULES.md + AGENTS.md      → systemPrompt (preset = claude_code, append = stitched)
 *
 * Out of scope (future): tools/ → MCP, agents/ → sub-agents, hooks/, full compliance.
 */
export async function gapToClaudeAgentOptions(
  manifest: GapManifest,
  workdir: string,
): Promise<ClaudeAgentOptions> {
  const append = await stitchSystemPrompt(workdir, manifest);
  const opts: ClaudeAgentOptions = {
    systemPrompt: { type: "preset", preset: "claude_code", append },
  };
  if (manifest.model?.preferred) opts.model = manifest.model.preferred;
  if (manifest.runtime?.max_turns) opts.maxTurns = manifest.runtime.max_turns;
  if (manifest.runtime?.budget_usd !== undefined) opts.maxBudgetUsd = manifest.runtime.budget_usd;
  return opts;
}

async function stitchSystemPrompt(workdir: string, m: GapManifest): Promise<string> {
  const sections: string[] = [];
  sections.push(`# Identity\nname: ${m.name}\nversion: ${m.version}`);
  if (m.description) sections.push(`description: ${m.description}`);

  const soul = await readIfPresent(join(workdir, "SOUL.md"));
  if (soul) sections.push(`# Soul\n\n${soul.trim()}`);

  const rules = await readIfPresent(join(workdir, "RULES.md"));
  if (rules) sections.push(`# Rules\n\n${rules.trim()}`);

  const agentsMd = await readIfPresent(join(workdir, "AGENTS.md"));
  if (agentsMd) sections.push(`# Agents\n\n${agentsMd.trim()}`);

  return sections.join("\n\n");
}

async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}
