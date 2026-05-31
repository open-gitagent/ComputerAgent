import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import type { BootHarnessOptions, BootedHarness, Substrate } from "@open-gitagent/sdk";
import { createLogger } from "@open-gitagent/protocol";
import { buildBwrapArgs } from "./bwrap-args.js";

// We reuse runtime-local's bundle — same engines, same loader, same logger.
// This package depends on @open-gitagent/runtime-local as a workspace dep
// so the path resolves at build time.
const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_BUNDLE_PATH = resolve(HERE, "../../runtime-local/assets/harness-bundle.mjs");

export interface BwrapSubstrateOptions {
  /** Path to the bwrap binary. Default: `bwrap` (looked up on PATH). */
  readonly bwrapPath?: string;
  /** Override the harness bundle. Default: runtime-local's bundle. */
  readonly bundlePath?: string;
  /** Override the Node binary. Default: same `node` we're running under. */
  readonly nodePath?: string;
  /** Root under which per-session workdirs are created. Default: $TMPDIR/computeragent-bwrap. */
  readonly sessionRoot?: string;
  /** Polling interval (ms) for /v1/health while booting. */
  readonly readinessPollMs?: number;
  /** Max time (ms) to wait for /v1/health. */
  readonly readinessTimeoutMs?: number;
  /** Receives every line of child stdout/stderr. Default: relay to parent stderr. */
  readonly onLog?: (line: string) => void;
  /** Extra read-only bind-mounts (see bwrap-args BwrapArgsOptions). */
  readonly extraRoBinds?: ReadonlyArray<{ src: string; dest?: string }>;
  /**
   * Share the host network namespace. Default `true` — agents need to reach
   * the Anthropic API. Set false for hermetic mode (no outbound network).
   */
  readonly shareNetwork?: boolean;
}

/**
 * Substrate implementation that wraps the harness server in a `bwrap`
 * sandbox. Linux-only. Each `bootHarness()` call:
 *
 *   1. Verifies `bwrap --version` runs (fail-fast on macOS / missing binary).
 *   2. Picks a free localhost port (under the parent's PID namespace — the
 *      shared net namespace means the sandbox's 127.0.0.1 is ours too).
 *   3. Creates a per-session workdir.
 *   4. Spawns `bwrap` with the policy from `buildBwrapArgs(...)`, launching
 *      `node /harness/harness.mjs` inside the sandbox.
 *   5. Polls `/v1/health` until ready.
 *   6. Returns `{ baseUrl, shutdown }`.
 *
 * Mirrors the LocalSubstrate shape — drop-in replacement.
 */
export class BwrapSubstrate implements Substrate {
  private readonly opts: BwrapSubstrateOptions;

  constructor(opts: BwrapSubstrateOptions = {}) {
    this.opts = opts;
  }

  async bootHarness(opts: BootHarnessOptions): Promise<BootedHarness> {
    const logger = createLogger({ component: "substrate.bwrap" });
    const bwrapBin = this.opts.bwrapPath ?? "bwrap";
    assertBwrapAvailable(bwrapBin);

    const log = this.opts.onLog ?? defaultOnLog;
    const bundlePath = this.opts.bundlePath ?? DEFAULT_BUNDLE_PATH;
    const nodePath = this.opts.nodePath ?? process.execPath;

    const port = await pickFreePort();
    const workdir = await makeSessionWorkdir(this.opts.sessionRoot);
    logger.info("boot", { runtime: "bwrap", port, workdir, bundlePath });

    const args = buildBwrapArgs({
      bundlePath,
      nodePath,
      workdir,
      port,
      envs: opts.envs,
      ...(this.opts.shareNetwork !== undefined ? { shareNetwork: this.opts.shareNetwork } : {}),
      ...(this.opts.extraRoBinds ? { extraRoBinds: this.opts.extraRoBinds } : {}),
    });

    const child = spawn(bwrapBin, args, { stdio: ["ignore", "pipe", "pipe"] });

    // Relay child stdout/stderr verbatim so the harness's structured log
    // lines (Wedge 1.9) surface in the parent terminal.
    child.stdout?.on("data", (b: Buffer) => {
      const t = b.toString().trimEnd();
      if (t) log(`[harness:stdout] ${t}`);
    });
    child.stderr?.on("data", (b: Buffer) => {
      const t = b.toString();
      if (t) log(t.endsWith("\n") ? t.slice(0, -1) : t);
    });

    const baseUrl = `http://127.0.0.1:${port}`;
    try {
      await waitForHealth(
        baseUrl,
        this.opts.readinessPollMs ?? 200,
        this.opts.readinessTimeoutMs ?? 30_000,
        child,
      );
      logger.info("harness.ready", { runtime: "bwrap", url: baseUrl, pid: child.pid });
    } catch (err) {
      child.kill("SIGTERM");
      logger.error("boot_failed", {
        runtime: "bwrap",
        url: baseUrl,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }

    let killed = false;
    return {
      baseUrl,
      shutdown: async () => {
        if (killed) return;
        killed = true;
        logger.info("dispose", { runtime: "bwrap", pid: child.pid });
        await killProcess(child, 5_000);
      },
    };
  }
}

// ── helpers ──────────────────────────────────────────────────────────────

function assertBwrapAvailable(bin: string): void {
  if (process.platform !== "linux") {
    throw new Error(
      `BwrapSubstrate: bubblewrap is Linux-only (platform=${process.platform}). ` +
        `Use LocalSubstrate for development on macOS/Windows.`,
    );
  }
  try {
    const res = spawnSync(bin, ["--version"], { stdio: "ignore" });
    if (res.status !== 0) {
      throw new Error(`${bin} --version exited with status ${res.status}`);
    }
  } catch (err) {
    throw new Error(
      `BwrapSubstrate: bwrap binary not found at "${bin}". ` +
        `Install bubblewrap (Debian/Ubuntu: \`apt install bubblewrap\`, ` +
        `RHEL/Fedora: \`dnf install bubblewrap\`). ` +
        `Underlying error: ${(err as Error).message}`,
    );
  }
}

async function makeSessionWorkdir(root: string | undefined): Promise<string> {
  const base = root ?? join(tmpdir(), "computeragent-bwrap");
  await mkdir(base, { recursive: true });
  return mkdtemp(join(base, "sess-"));
}

function pickFreePort(): Promise<number> {
  return new Promise((resolveP, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => resolveP(port));
      } else {
        srv.close();
        reject(new Error("could not obtain a free port"));
      }
    });
  });
}

async function waitForHealth(
  baseUrl: string,
  pollMs: number,
  timeoutMs: number,
  child: ChildProcess,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `harness (bwrap) exited with code ${child.exitCode} before becoming healthy`,
      );
    }
    try {
      const res = await fetch(`${baseUrl}/v1/health`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(pollMs);
  }
  throw new Error(`BwrapSubstrate: harness did not become healthy within ${timeoutMs}ms`);
}

async function killProcess(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.killed) return;
  // Give the child a tick to flush final log lines (Wedge 1.9 stderr race).
  await new Promise<void>((r) => setTimeout(r, 250));
  if (child.exitCode !== null || child.killed) return;
  return new Promise<void>((resolveP) => {
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      resolveP();
    }, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolveP();
    });
    try {
      child.kill("SIGTERM");
    } catch {
      clearTimeout(timer);
      resolveP();
    }
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function defaultOnLog(line: string): void {
  try {
    process.stderr.write(line + "\n");
  } catch {
    /* swallow */
  }
}
