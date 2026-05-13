import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { BootHarnessOptions, BootedHarness, Substrate } from "@computeragent/sdk";

const BUNDLE_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../assets/harness-bundle.mjs");

export interface LocalSubstrateOptions {
  /** Override the harness bundle path (mainly for tests / local dev). */
  readonly bundlePath?: string;
  /** Override the Node binary used to run the bundle. Default: same `node` we're running under. */
  readonly nodePath?: string;
  /** Polling interval (ms) for /v1/health while booting. */
  readonly readinessPollMs?: number;
  /** Max time (ms) to wait for /v1/health to become ready. */
  readonly readinessTimeoutMs?: number;
  /** Log callback for subprocess stdout/stderr. */
  readonly onLog?: (line: string) => void;
}

/**
 * Boots the harness server as a managed Node subprocess on the local machine.
 *
 * Per-`bootHarness()` call:
 *   1. Pick a free localhost port.
 *   2. `spawn('node', [bundlePath])` with the caller's envs and PORT=<random>.
 *   3. Poll `http://127.0.0.1:<port>/v1/health` until ready.
 *   4. Return `{ baseUrl, shutdown }`. shutdown() sends SIGTERM and awaits exit.
 *
 * Same Substrate interface as `runtime-e2b`. Zero external dependencies — useful
 * for local dev, deterministic tests, and multi-tenant local fan-out.
 */
export class LocalSubstrate implements Substrate {
  constructor(private readonly opts: LocalSubstrateOptions = {}) {}

  async bootHarness(opts: BootHarnessOptions): Promise<BootedHarness> {
    const log = this.opts.onLog ?? (() => {});
    const bundlePath = this.opts.bundlePath ?? BUNDLE_PATH;
    const nodeBin = this.opts.nodePath ?? process.execPath;

    const port = await pickFreePort();
    log(`spawning ${nodeBin} ${bundlePath}  (PORT=${port})`);

    const child = spawn(nodeBin, [bundlePath], {
      env: { ...process.env, ...opts.envs, PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout?.on("data", (b: Buffer) => log(`[harness:stdout] ${b.toString().trimEnd()}`));
    child.stderr?.on("data", (b: Buffer) => log(`[harness:stderr] ${b.toString().trimEnd()}`));

    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      await waitForHealth(
        baseUrl,
        this.opts.readinessPollMs ?? 200,
        this.opts.readinessTimeoutMs ?? 30_000,
        log,
        child,
      );
    } catch (err) {
      child.kill("SIGTERM");
      throw err;
    }

    let killed = false;
    return {
      baseUrl,
      shutdown: async () => {
        if (killed) return;
        killed = true;
        log(`shutting down harness subprocess`);
        await killProcess(child, 5_000);
      },
    };
  }
}

// ── helpers ──────────────────────────────────────────────────────────────

/** Bind to :0 to let the OS pick a free port, then close and return it. */
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
  log: (s: string) => void,
  child: ChildProcess,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`harness subprocess exited with code ${child.exitCode} before becoming healthy`);
    }
    attempts += 1;
    try {
      const res = await fetch(`${baseUrl}/v1/health`);
      if (res.ok) {
        log(`harness healthy after ${attempts} probe(s)`);
        return;
      }
    } catch {
      /* not up yet */
    }
    await sleep(pollMs);
  }
  throw new Error(`LocalSubstrate: harness did not become healthy within ${timeoutMs}ms`);
}

async function killProcess(child: ChildProcess, timeoutMs: number): Promise<void> {
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
