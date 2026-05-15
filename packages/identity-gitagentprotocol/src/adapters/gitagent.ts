import type { GapManifest } from "../manifest.js";

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
  if (manifest.model?.preferred) opts.model = manifest.model.preferred;
  if (manifest.runtime?.max_turns) opts.maxTurns = manifest.runtime.max_turns;
  // Pass GAP's declared temperature as a flat field; the engine folds it
  // into gitclaw's `constraints.temperature`. Caller-supplied `temperature`
  // overrides via the standard mergeEngineOptions chain. See Wedge 1.7.
  if (manifest.model?.constraints?.temperature !== undefined) {
    (opts as GitagentOptions & { temperature?: number }).temperature =
      manifest.model.constraints.temperature;
  }
  // gitclaw does not yet expose a permission-mode knob through its options
  // surface; HITL enforcement on this engine is a future-PR concern.
  return { options: opts, harden: (m) => m };
}
