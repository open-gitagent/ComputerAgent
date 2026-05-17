import type { GapManifest } from "../manifest.js";

/**
 * Gitclaw requires model strings in `provider:modelId` form (e.g.
 * `anthropic:claude-sonnet-4-5-20250929`). Most GAP repos in the wild use
 * the Claude Agent SDK's bare form (`claude-sonnet-4-5-20250929`). Normalize
 * here so the same `agent.yaml` works across engines.
 *
 * Heuristic: a bare `claude-*` / `claude-3-*` etc. string gets `anthropic:`
 * prefixed. `gpt-*` and `o*` get `openai:`. Strings that already contain
 * `:` are passed through unchanged. Everything else is passed through and
 * gitclaw will surface its own error if the provider is unknown.
 */
function normalizeGitclawModel(model: string): string {
  if (model.includes(":")) return model;
  if (/^claude-/i.test(model)) return `anthropic:${model}`;
  if (/^(gpt-|o[13]-|o4-)/i.test(model)) return `openai:${model}`;
  if (/^gemini-/i.test(model)) return `google:${model}`;
  return model;
}

/**
 * GAP → gitagent options translator.
 *
 * Gitagent (the bot) natively reads GAP repos: it auto-discovers `agent.yaml`,
 * `SOUL.md`, `RULES.md`, `skills/`, `tools/`, `memory/`, `hooks/` from `dir`.
 * So the adapter is intentionally thin — we just point gitagent at the workdir
 * and let it self-configure. Manifest fields that gitagent's loader will already
 * consume (model, maxTurns) are passed through here only when overriding makes
 * sense for callers running headless.
 */
export interface GitagentOptions {
  dir: string;
  model?: string;
  maxTurns?: number;
  /**
   * Compliance-driven permission requirement. When the GAP manifest declares
   * `compliance.supervision.human_in_the_loop: always` or `destructive`, the
   * engine MUST gate tool calls through `onPermissionRequest` regardless of
   * what the caller passes. Set by `harden()` — see Wedge 1.8.
   */
  requireHumanReview?: boolean;
}

export interface GitagentAdapterResult {
  options: GitagentOptions;
  harden: (merged: GitagentOptions) => GitagentOptions;
}

export async function gapToGitagentOptions(
  manifest: GapManifest,
  workdir: string,
): Promise<GitagentAdapterResult> {
  const opts: GitagentOptions = { dir: workdir };
  if (manifest.model?.preferred) opts.model = normalizeGitclawModel(manifest.model.preferred);
  if (manifest.runtime?.max_turns) opts.maxTurns = manifest.runtime.max_turns;
  // Pass GAP's declared temperature as a flat field; the engine folds it
  // into gitclaw's `constraints.temperature`. Caller-supplied `temperature`
  // overrides via the standard mergeEngineOptions chain. See Wedge 1.7.
  if (manifest.model?.constraints?.temperature !== undefined) {
    (opts as GitagentOptions & { temperature?: number }).temperature =
      manifest.model.constraints.temperature;
  }
  // Compliance enforcement (Wedge 1.8): when `compliance.supervision.human_in_the_loop`
  // is "always" or "destructive", flip the `requireHumanReview` flag on hardened
  // options. The engine reads this flag and ensures the preToolUse hook is wired
  // (it always is today — but the flag signals "no override allowed"). gitclaw
  // doesn't have a permissionMode equivalent like the Claude SDK, so this is
  // the canonical lever for gitagent.
  const hitl = manifest.compliance?.supervision?.human_in_the_loop;
  const requireHumanReview = hitl === "always" || hitl === "destructive";

  return {
    options: opts,
    harden: (merged) => {
      if (requireHumanReview) {
        return { ...merged, requireHumanReview: true };
      }
      return merged;
    },
  };
}
