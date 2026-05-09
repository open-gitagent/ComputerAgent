import { realpath } from "node:fs/promises";
import { isAbsolute, normalize, resolve, sep } from "node:path";

/**
 * Path containment ("jail") for filesystem routes.
 *
 * Rejects every input that could escape the session workdir:
 *   - absolute paths
 *   - `..` traversal
 *   - null bytes
 *   - empty/whitespace strings
 *   - resolved paths outside the workdir (catches symlinks pointing out)
 *
 * Returns the absolute, normalized path inside the workdir on success.
 *
 * Pure-ish: uses `realpath` only for symlink resolution when `checkSymlinks`
 * is true (default). Tests that hit only string-level rules can skip that.
 */

export class PathEscapeError extends Error {
  constructor(message: string, readonly attempted: string) {
    super(message);
    this.name = "PathEscapeError";
  }
}

export interface JailOptions {
  /**
   * Check resolved-path containment via `fs.realpath` (catches symlinks pointing
   * outside the jail). Default true. Tests for string-only rules can pass false.
   */
  readonly checkSymlinks?: boolean;
  /**
   * If true, allow paths whose target doesn't exist yet (used by write/mkdir).
   * String-level rules still apply. Default true.
   */
  readonly allowNonExistent?: boolean;
}

const DEFAULTS: Required<JailOptions> = { checkSymlinks: true, allowNonExistent: true };

export async function resolveJailedPath(
  workdir: string,
  relPath: string,
  opts: JailOptions = {},
): Promise<string> {
  const { checkSymlinks, allowNonExistent } = { ...DEFAULTS, ...opts };

  if (typeof relPath !== "string" || relPath.trim() === "") {
    throw new PathEscapeError("path must be a non-empty string", String(relPath));
  }
  if (relPath.includes("\0")) {
    throw new PathEscapeError("path contains null byte", relPath);
  }
  if (isAbsolute(relPath)) {
    throw new PathEscapeError("absolute paths are not allowed", relPath);
  }

  const normalized = normalize(relPath);
  if (normalized.startsWith("..") || normalized === ".." || normalized.includes(`${sep}..${sep}`)) {
    throw new PathEscapeError("parent traversal is not allowed", relPath);
  }

  // Realpath the root once so symlink-prefixed paths (e.g. /tmp -> /private/tmp on
  // macOS) don't break containment comparisons.
  const root = checkSymlinks ? await realpathSafe(resolve(workdir)) : resolve(workdir);
  const candidate = resolve(root, normalized);
  if (!isInside(root, candidate)) {
    throw new PathEscapeError("path resolves outside the workdir", relPath);
  }

  if (checkSymlinks) {
    try {
      const real = await realpath(candidate);
      if (!isInside(root, real)) {
        throw new PathEscapeError("symlink target is outside the workdir", relPath);
      }
      return real;
    } catch (err) {
      if (allowNonExistent && (err as NodeJS.ErrnoException).code === "ENOENT") {
        return candidate;
      }
      if (err instanceof PathEscapeError) throw err;
      throw err;
    }
  }
  return candidate;
}

async function realpathSafe(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    return p;
  }
}

function isInside(root: string, candidate: string): boolean {
  const r = resolve(root);
  const c = resolve(candidate);
  return c === r || c.startsWith(r + sep);
}
