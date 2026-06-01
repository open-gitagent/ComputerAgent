import { cp, mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import simpleGit from "simple-git";
import type { IdentitySource } from "@open-gitagent/protocol";

/**
 * Resolve an `IdentitySource` into a fully-materialized directory on disk.
 *
 * The harness server already provides a per-session `workdir`; we materialize
 * the GAP repo *inside* it so cleanup is automatic when the session ends.
 *
 * Pure orchestration — no validation; no GAP-specific knowledge. Validates only
 * that the source resolved into something readable.
 */
export async function materialize(source: IdentitySource, workdir: string): Promise<string> {
  if (source.type === "local") {
    await cp(source.path, workdir, { recursive: true, errorOnExist: false });
    return workdir;
  }
  if (source.type === "git") {
    // Idempotent on resume: the harness reuses the same `workdir` when a
    // session is restored under a stable sessionId (sessionStore in play).
    // If we already cloned into this dir on a prior boot, `git clone` would
    // fail with "destination path already exists and is not an empty
    // directory" — so detect that and skip re-cloning. Identity is fixed
    // per-sessionId by contract, so the existing checkout is the right one.
    if (await hasGitCheckout(workdir)) {
      return source.subdir ? join(workdir, source.subdir) : workdir;
    }
    const url = normalizeGitUrl(source.url);
    const opts: string[] = ["--depth", "1"];
    if (source.ref) opts.push("--branch", source.ref);
    await simpleGit().clone(url, workdir, opts);
    return source.subdir ? join(workdir, source.subdir) : workdir;
  }
  if (source.type === "inline") {
    await mkdir(workdir, { recursive: true });
    if (source.files) {
      for (const [relPath, body] of Object.entries(source.files)) {
        const target = join(workdir, relPath);
        await mkdir(join(target, ".."), { recursive: true });
        await writeFile(target, body, "utf8");
      }
    }
    // The manifest itself goes to agent.yaml unless files[] already provided one.
    if (!source.files?.["agent.yaml"]) {
      await writeFile(
        join(workdir, "agent.yaml"),
        // a minimal YAML serialization is enough; users with rich manifests should
        // pass them via files[]
        defaultManifestYaml(source.manifest),
        "utf8",
      );
    }
    return workdir;
  }
  // exhaustive
  const _exhaustive: never = source;
  throw new Error(`unknown identity source: ${(_exhaustive as { type: string }).type}`);
}

async function hasGitCheckout(dir: string): Promise<boolean> {
  try {
    const st = await stat(join(dir, ".git"));
    return st.isDirectory() || st.isFile(); // .git can be a file for worktrees/submodules
  } catch {
    return false;
  }
}

/** Accepts bare `github.com/x/y` and prefixes `https://` for `git clone`. */
function normalizeGitUrl(input: string): string {
  if (/^(https?:\/\/|git@|git:\/\/|ssh:\/\/)/.test(input)) return input;
  return `https://${input}.git`;
}

function defaultManifestYaml(manifest: Record<string, unknown>): string {
  // keep dependency surface minimal; this is a one-off serializer for inline mode
  return Object.entries(manifest)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join("\n");
}
