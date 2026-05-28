import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ClaudeAgentOptions } from "@open-gitagent/protocol";
import type { GapManifest } from "../manifest.js";
import { loadGapTools } from "../tools.js";
import { loadGapSubagents } from "../subagents.js";
import { loadGapHooks } from "../hooks.js";

export interface ClaudeAdapterResult {
  options: ClaudeAgentOptions;
  /** Post-merge hardening: enforces GAP compliance constraints over any caller overrides. */
  harden: (merged: ClaudeAgentOptions) => ClaudeAgentOptions;
}

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
 * Compliance hardening (strictest-wins, applied AFTER caller options merge in):
 *   compliance.supervision.human_in_the_loop in {always, destructive}
 *     → permissionMode: 'default' (overrides caller's bypassPermissions)
 *
 * Out of scope (future): tools/ → MCP, agents/ → sub-agents, hooks/.
 */
export async function gapToClaudeAgentOptions(
  manifest: GapManifest,
  workdir: string,
): Promise<ClaudeAdapterResult> {
  const append = await stitchSystemPrompt(workdir, manifest);
  const opts: ClaudeAgentOptions = {
    systemPrompt: { type: "preset", preset: "claude_code", append },
  };
  if (manifest.model?.preferred) opts.model = manifest.model.preferred;
  if (manifest.runtime?.max_turns) opts.maxTurns = manifest.runtime.max_turns;
  if (manifest.runtime?.budget_usd !== undefined) opts.maxBudgetUsd = manifest.runtime.budget_usd;
  // Carry the GAP-declared temperature through as a flat opt. The engine
  // decides what to do with it — gitclaw folds it into `constraints`,
  // claude-agent-sdk currently can't (no `temperature` on its public
  // `Options` type) and warns. Caller-supplied `temperature` overrides this
  // via the standard mergeEngineOptions chain. See Wedge 1.7.
  if (manifest.model?.constraints?.temperature !== undefined) {
    (opts as ClaudeAgentOptions & { temperature?: number }).temperature =
      manifest.model.constraints.temperature;
  }

  const tools = await loadGapTools(workdir);
  if (tools.allowedTools.length > 0 || tools.mcpToolNames.length > 0) {
    opts.allowedTools = [...tools.allowedTools, ...tools.mcpToolNames];
  }
  if (tools.mcpServer) {
    opts.mcpServers = { gap_tools: tools.mcpServer };
  }

  const agents = await loadGapSubagents(workdir);
  if (Object.keys(agents).length > 0) {
    opts.agents = agents;
  }

  const hooks = await loadGapHooks(workdir);
  if (Object.keys(hooks).length > 0) {
    opts.hooks = hooks;
  }

  const hitl = manifest.compliance?.supervision?.human_in_the_loop;
  const requiresHumanReview = hitl === "always" || hitl === "destructive";

  return {
    options: opts,
    harden: (merged) => {
      if (requiresHumanReview && merged.permissionMode === "bypassPermissions") {
        return { ...merged, permissionMode: "default" };
      }
      return merged;
    },
  };
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
