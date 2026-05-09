import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PathEscapeError, resolveJailedPath } from "./path-jail.js";

let workdir: string;
let realWorkdir: string;
let outsideDir: string;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "ca-jail-test-"));
  realWorkdir = await realpath(workdir);
  outsideDir = await mkdtemp(join(tmpdir(), "ca-jail-outside-"));
});
afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
  await rm(outsideDir, { recursive: true, force: true });
});

describe("resolveJailedPath — hostile inputs", () => {
  it("rejects an absolute path", async () => {
    await expect(resolveJailedPath(workdir, "/etc/passwd")).rejects.toThrow(PathEscapeError);
  });

  it("rejects parent traversal '..'", async () => {
    await expect(resolveJailedPath(workdir, "..")).rejects.toThrow(PathEscapeError);
    await expect(resolveJailedPath(workdir, "../../etc/passwd")).rejects.toThrow(PathEscapeError);
  });

  it("rejects mid-path traversal", async () => {
    await expect(resolveJailedPath(workdir, "ok/../../escape")).rejects.toThrow(PathEscapeError);
  });

  it("rejects null bytes", async () => {
    await expect(resolveJailedPath(workdir, "ok\0.txt")).rejects.toThrow(/null byte/);
  });

  it("rejects empty / whitespace-only strings", async () => {
    await expect(resolveJailedPath(workdir, "")).rejects.toThrow(PathEscapeError);
    await expect(resolveJailedPath(workdir, "   ")).rejects.toThrow(PathEscapeError);
  });

  it("rejects non-string inputs", async () => {
    await expect(
      resolveJailedPath(workdir, undefined as unknown as string),
    ).rejects.toThrow(PathEscapeError);
  });

  it("rejects a symlink pointing outside the workdir", async () => {
    const target = join(outsideDir, "secret.txt");
    await writeFile(target, "outside", "utf8");
    await symlink(target, join(workdir, "exit-link"));
    await expect(resolveJailedPath(workdir, "exit-link")).rejects.toThrow(/outside/);
  });
});

describe("resolveJailedPath — happy path", () => {
  it("accepts a simple relative path that doesn't exist yet (write case)", async () => {
    const out = await resolveJailedPath(workdir, "foo.txt");
    expect(out.startsWith(realWorkdir)).toBe(true);
  });

  it("accepts a nested relative path", async () => {
    await mkdir(join(workdir, "deep", "nested"), { recursive: true });
    await writeFile(join(workdir, "deep", "nested", "file.txt"), "hi", "utf8");
    const out = await resolveJailedPath(workdir, "deep/nested/file.txt");
    expect(out.endsWith(join("deep", "nested", "file.txt"))).toBe(true);
  });

  it("accepts the workdir root itself", async () => {
    const out = await resolveJailedPath(workdir, ".");
    expect(out).toBe(realWorkdir);
  });

  it("accepts a symlink whose target is inside the workdir", async () => {
    const real = join(workdir, "real.txt");
    await writeFile(real, "in", "utf8");
    await symlink(real, join(workdir, "alias.txt"));
    const out = await resolveJailedPath(workdir, "alias.txt");
    expect(out.startsWith(realWorkdir)).toBe(true);
  });
});
