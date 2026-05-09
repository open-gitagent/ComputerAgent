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

export async function gapToGitagentOptions(
  manifest: GapManifest,
  workdir: string,
): Promise<GitagentOptions> {
  const opts: GitagentOptions = { dir: workdir };
  if (manifest.model?.preferred) opts.model = manifest.model.preferred;
  if (manifest.runtime?.max_turns) opts.maxTurns = manifest.runtime.max_turns;
  return opts;
}
