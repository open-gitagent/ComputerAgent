import { access, cp, mkdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * Mirror `<workdir>/skills/` to `<workdir>/.claude/skills/` so Claude Code
 * auto-discovers GAP skills via its native settings sources.
 *
 * Idempotent. No-op if `skills/` doesn't exist.
 */
export async function mirrorSkillsForClaude(workdir: string): Promise<void> {
  const src = join(workdir, "skills");
  if (!(await exists(src))) return;
  const dest = join(workdir, ".claude", "skills");
  await mkdir(join(workdir, ".claude"), { recursive: true });
  await cp(src, dest, { recursive: true, force: true });
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
