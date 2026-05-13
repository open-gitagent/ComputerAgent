import { spawn, type ChildProcess } from "node:child_process";

/**
 * Thin wrapper around the `tart` CLI (Cirrus Labs). We shell out instead of
 * using a native VZ binding because tart is the most mature VZ wrapper on
 * Apple Silicon and gives us clone/run/ip/stop/delete in 5 commands.
 *
 * Requires:
 *   - macOS on Apple Silicon
 *   - `brew install cirruslabs/cli/tart`
 *   - A base image, e.g. `tart pull ghcr.io/cirruslabs/ubuntu:latest`
 */

export interface TartOptions {
  /** Path to the `tart` binary. Default: just `tart` (resolved via PATH). */
  readonly tartBin?: string;
}

const DEFAULT_TART = "tart";

export async function tartClone(source: string, name: string, opts: TartOptions = {}): Promise<void> {
  await runTart([opts.tartBin ?? DEFAULT_TART, "clone", source, name]);
}

export async function tartDelete(name: string, opts: TartOptions = {}): Promise<void> {
  await runTart([opts.tartBin ?? DEFAULT_TART, "delete", name]);
}

export async function tartStop(name: string, opts: TartOptions = {}): Promise<void> {
  await runTart([opts.tartBin ?? DEFAULT_TART, "stop", name]);
}

/** Start a VM in the background; returns the child handle so the caller can kill it. */
export function tartRunBackground(name: string, opts: TartOptions = {}): ChildProcess {
  return spawn(opts.tartBin ?? DEFAULT_TART, ["run", "--no-graphics", name], {
    stdio: ["ignore", "ignore", "pipe"],
  });
}

/** Resolve the VM's IP. Tart populates this once the VM has finished booting. */
export async function tartIp(name: string, opts: TartOptions = {}): Promise<string> {
  const out = await runTart([opts.tartBin ?? DEFAULT_TART, "ip", name], { silent: true });
  return out.trim();
}

interface RunOpts {
  silent?: boolean;
}

function runTart(argv: string[], opts: RunOpts = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const [bin, ...rest] = argv;
    const child = spawn(bin!, rest, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b: Buffer) => (stdout += b.toString()));
    child.stderr.on("data", (b: Buffer) => (stderr += b.toString()));
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`tart ${rest.join(" ")} exited ${code}: ${stderr.trim() || stdout.trim()}`));
    });
  });
}
