import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { GapManifest } from "../manifest.js";

/**
 * GAP → deepagents options translator.
 *
 * deepagents (LangChain's deepagentsjs) takes a small, opinionated options
 * shape: { model, systemPrompt, temperature, ... }. SOUL.md / RULES.md /
 * AGENTS.md are stitched into systemPrompt because deepagents doesn't have
 * a "preset + append" mechanism like Claude Agent SDK does.
 */
export interface DeepAgentsAdapterOptions {
  model?: string;
  systemPrompt?: string;
  temperature?: number;
  maxTurns?: number;
}

export interface DeepAgentsAdapterResult {
  options: DeepAgentsAdapterOptions;
  harden: (merged: DeepAgentsAdapterOptions) => DeepAgentsAdapterOptions;
}

export async function gapToDeepAgentsOptions(
  manifest: GapManifest,
  workdir: string,
): Promise<DeepAgentsAdapterResult> {
  const opts: DeepAgentsAdapterOptions = {};

  if (manifest.model?.preferred) opts.model = manifest.model.preferred;
  if (manifest.runtime?.max_turns) opts.maxTurns = manifest.runtime.max_turns;
  if (manifest.model?.constraints?.temperature !== undefined) {
    opts.temperature = manifest.model.constraints.temperature;
  }

  // Stitch SOUL + RULES + AGENTS into a single system prompt, mirroring what
  // the claude-agent-sdk adapter does. deepagents has no preset to append to,
  // so this becomes the WHOLE system prompt (deepagents has its own internal
  // default prompt for planning/filesystem tools that runs alongside ours).
  const systemPrompt = await stitchSystemPrompt(workdir, manifest);
  if (systemPrompt) opts.systemPrompt = systemPrompt;

  // Compliance enforcement — same shape as gitagent. deepagents has tool
  // gating via LangGraph middleware, but we don't have a wired permission
  // bridge yet, so this is currently advisory: future-work flag for when
  // the engine grows a permission-callback path.
  const hitl = manifest.compliance?.supervision?.human_in_the_loop;
  const requireHumanReview = hitl === "always" || hitl === "destructive";

  return {
    options: opts,
    harden: (merged) => {
      if (requireHumanReview) {
        return { ...merged, requireHumanReview: true } as DeepAgentsAdapterOptions & {
          requireHumanReview: true;
        };
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

  const agents = await readIfPresent(join(workdir, "AGENTS.md"));
  if (agents) sections.push(`# Agents\n\n${agents.trim()}`);

  return sections.join("\n\n");
}

async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}
