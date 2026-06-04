// Shared cascade-delete helpers for the dashboard delete surfaces (agent +
// session). Both need the same two side-effects against the harness:
//   1. dispose any live sandbox for the affected sessions
//   2. delete the matching S3 snapshots (auto-saved under agentos/<name>/)
//
// Mongo deletes stay in the route handlers — they're trivial deleteMany calls
// and keep the collection wiring next to the rest of each route. These helpers
// own only the cross-process (harness/S3) work, which is the part that can
// fail independently and must degrade gracefully.

import { caBase, caDelete } from "./upstream.js";
import { caAuthHeader } from "./auth.js";

export interface CleanupResult {
  sandboxes: number;          // live sandboxes disposed
  snapshots: number;          // S3 snapshots deleted
  warnings: string[];         // non-fatal harness/S3 failures
}

interface SandboxListItem { sandboxId: string; sessionId: string; state: string }
interface SnapshotItem { snapshotId: string; sourceSessionId: string }

/**
 * Dispose every live sandbox whose session is in `sessionIds`. Best-effort:
 * an unreachable harness yields a warning, never a throw. The dispose is sent
 * with `?save=false` so the harness skips its auto-save snapshot (the caller
 * is about to delete the agent's S3 state anyway).
 */
export async function disposeLiveSandboxes(sessionIds: Set<string>): Promise<{ disposed: number; warnings: string[] }> {
  const warnings: string[] = [];
  if (sessionIds.size === 0) return { disposed: 0, warnings };

  let sandboxes: SandboxListItem[] = [];
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 2_000);
    const r = await fetch(`${caBase()}/sandboxes`, { headers: caAuthHeader(), signal: ctl.signal })
      .finally(() => clearTimeout(timer));
    if (r.ok) {
      const j = (await r.json()) as { sandboxes?: SandboxListItem[] };
      sandboxes = j.sandboxes ?? [];
    } else {
      warnings.push(`list sandboxes → ${r.status}`);
    }
  } catch (err) {
    warnings.push(`list sandboxes unreachable: ${err instanceof Error ? err.message : String(err)}`);
    return { disposed: 0, warnings };
  }

  let disposed = 0;
  for (const sb of sandboxes) {
    if (!sessionIds.has(sb.sessionId)) continue;
    try {
      await caDelete(`/sandboxes/${encodeURIComponent(sb.sandboxId)}?save=false`);
      disposed++;
    } catch (err) {
      warnings.push(`dispose ${sb.sandboxId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { disposed, warnings };
}

/**
 * Delete S3 snapshots under an agent's prefix (`agentos/<name>/`). When
 * `sessionId` is given, only snapshots whose `sourceSessionId` matches are
 * deleted; otherwise the whole prefix is swept. Best-effort with warnings.
 */
export async function deleteAgentSnapshots(
  name: string,
  opts: { sessionId?: string } = {},
): Promise<{ deleted: number; warnings: string[] }> {
  const warnings: string[] = [];
  const prefix = `agentos/${name}/`;
  const q = `stateStore=s3&prefix=${encodeURIComponent(prefix)}`;

  let snaps: SnapshotItem[] = [];
  try {
    const r = await fetch(`${caBase()}/snapshots?${q}`, { headers: caAuthHeader() });
    if (r.ok) {
      const j = (await r.json()) as { snapshots?: SnapshotItem[] };
      snaps = j.snapshots ?? [];
    } else {
      // 400 UNKNOWN_STATE_STORE just means the harness has no S3 store
      // registered (S3_BUCKET unset) — there's no S3 state to sweep, so this
      // is expected, not a problem. Only surface genuinely unexpected errors.
      const body = (await r.json().catch(() => ({}))) as { error?: { code?: string } };
      if (r.status === 400 && body.error?.code === "UNKNOWN_STATE_STORE") {
        return { deleted: 0, warnings };
      }
      warnings.push(`list snapshots → ${r.status}`);
      return { deleted: 0, warnings };
    }
  } catch (err) {
    warnings.push(`list snapshots unreachable: ${err instanceof Error ? err.message : String(err)}`);
    return { deleted: 0, warnings };
  }

  if (opts.sessionId) snaps = snaps.filter((s) => s.sourceSessionId === opts.sessionId);

  let deleted = 0;
  for (const s of snaps) {
    try {
      await caDelete(`/snapshots/${encodeURIComponent(s.snapshotId)}?${q}`);
      deleted++;
    } catch (err) {
      warnings.push(`delete snapshot ${s.snapshotId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { deleted, warnings };
}
