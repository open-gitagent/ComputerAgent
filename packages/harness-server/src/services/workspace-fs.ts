import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import type { FsTreeEntry } from "@computeragent/protocol";
import { resolveJailedPath } from "../path-jail.js";

/**
 * Path-jailed filesystem operations against a session workdir.
 *
 * In Wedge 1 these go straight through Node fs/promises. In Wedge 3 the same
 * surface will plug into a Substrate FS port so remote runtimes (E2B, Lyzr Compute)
 * can host the harness server unchanged.
 *
 * Every operation resolves through `resolveJailedPath` first — no I/O happens on
 * an unjailed path.
 */

export async function listTree(
  workdir: string,
  relPath: string,
  depth: number,
): Promise<FsTreeEntry[]> {
  const root = await resolveJailedPath(workdir, relPath || ".");
  return collect(root, root, Math.max(0, depth));
}

async function collect(root: string, dir: string, remaining: number): Promise<FsTreeEntry[]> {
  if (remaining < 0) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  const out: FsTreeEntry[] = [];
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    const s = await stat(abs);
    out.push({
      path: relative(root, abs) || entry.name,
      type: entry.isDirectory() ? "dir" : "file",
      size: s.size,
      mtime: Math.floor(s.mtimeMs),
      mode: s.mode,
    });
    if (entry.isDirectory() && remaining > 0) {
      // Recursive call already produces paths relative to `root`; no re-prefixing.
      const nested = await collect(root, abs, remaining - 1);
      for (const n of nested) out.push(n);
    }
  }
  return out;
}

export async function readBytes(workdir: string, relPath: string): Promise<Buffer> {
  const abs = await resolveJailedPath(workdir, relPath, { allowNonExistent: false });
  return readFile(abs);
}

export async function writeBytes(
  workdir: string,
  relPath: string,
  data: Buffer | string,
): Promise<{ size: number }> {
  const abs = await resolveJailedPath(workdir, relPath);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, data);
  const s = await stat(abs);
  return { size: s.size };
}

export async function editFile(
  workdir: string,
  relPath: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): Promise<{ replacements: number }> {
  const abs = await resolveJailedPath(workdir, relPath, { allowNonExistent: false });
  const original = await readFile(abs, "utf8");
  let replacements = 0;
  let updated: string;
  if (replaceAll) {
    updated = original.split(oldString).join(newString);
    replacements = (original.length - updated.length === 0 && oldString !== newString)
      ? 0
      : countOccurrences(original, oldString);
  } else {
    const idx = original.indexOf(oldString);
    if (idx === -1) {
      updated = original;
      replacements = 0;
    } else {
      updated = original.slice(0, idx) + newString + original.slice(idx + oldString.length);
      replacements = 1;
    }
  }
  if (replacements === 0) {
    throw new Error(`old_string not found in ${relPath}`);
  }
  await writeFile(abs, updated, "utf8");
  return { replacements };
}

export async function removePath(
  workdir: string,
  relPath: string,
  recursive: boolean,
): Promise<void> {
  const abs = await resolveJailedPath(workdir, relPath, { allowNonExistent: false });
  await rm(abs, { recursive, force: false });
}

export async function makeDir(
  workdir: string,
  relPath: string,
  recursive: boolean,
): Promise<void> {
  const abs = await resolveJailedPath(workdir, relPath);
  await mkdir(abs, { recursive });
}

export async function movePath(workdir: string, from: string, to: string): Promise<void> {
  const fromAbs = await resolveJailedPath(workdir, from, { allowNonExistent: false });
  const toAbs = await resolveJailedPath(workdir, to);
  await mkdir(dirname(toAbs), { recursive: true });
  await rename(fromAbs, toAbs);
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    n++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return n;
}
