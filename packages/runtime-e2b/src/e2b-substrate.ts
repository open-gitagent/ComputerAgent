import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { Sandbox } from "e2b";
import type { BootHarnessOptions, BootedHarness, Substrate } from "@computeragent/sdk";

/** Default port the harness server listens on inside the sandbox. */
const HARNESS_PORT = 7700;

/** Where the harness bundle lives relative to dist/ after `pnpm build`. */
const BUNDLE_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../assets/harness-bundle.cjs");

export interface E2BSubstrateOptions {
  /** E2B API key. Defaults to `process.env.E2B_API_KEY`. */
  readonly apiKey?: string;
  /** Sandbox template id. Defaults to E2B's "base" image which has Node + git. */
  readonly template?: string;
  /** Sandbox idle timeout in seconds. Defaults to 300 (5 min). */
  readonly timeoutMs?: number;
  /** Override the bundle path (mainly for tests / local dev). */
  readonly bundlePath?: string;
  /** Polling interval (ms) when waiting for /v1/health to come up. */
  readonly readinessPollMs?: number;
  /** Maximum time (ms) to wait for the harness server to become healthy. */
  readonly readinessTimeoutMs?: number;
  /** Optional log callback (e.g. for debugging). Receives single-line strings. */
  readonly onLog?: (line: string) => void;
}

/**
 * Boots a harness server inside an E2B sandbox.
 *
 * Pipeline (per `bootHarness` call):
 *   1. Create an E2B sandbox.
 *   2. Upload the pre-built harness bundle (single .cjs file) to /tmp/harness.cjs.
 *   3. Spawn `node /tmp/harness.cjs` with the caller's envs (e.g. ANTHROPIC_API_KEY).
 *   4. Poll the public port-forwarded URL for `/v1/health` until it's ready.
 *   5. Return `{ baseUrl, shutdown }`. SDK uses baseUrl just like localhost.
 */
export class E2BSubstrate implements Substrate {
  constructor(private readonly opts: E2BSubstrateOptions = {}) {}

  async bootHarness(opts: BootHarnessOptions): Promise<BootedHarness> {
    const apiKey = this.opts.apiKey ?? process.env.E2B_API_KEY;
    if (!apiKey) throw new Error("E2BSubstrate: missing apiKey (set E2B_API_KEY or pass apiKey)");

    const log = this.opts.onLog ?? (() => {});
    log(`creating sandbox`);
    const sandbox = await Sandbox.create({
      apiKey,
      ...(this.opts.template ? { template: this.opts.template } : {}),
      ...(this.opts.timeoutMs ? { timeoutMs: this.opts.timeoutMs } : {}),
    });

    try {
      log(`uploading harness bundle`);
      const bundlePath = this.opts.bundlePath ?? BUNDLE_PATH;
      const bundle = await readFile(bundlePath);
      // E2B's `files.write` accepts string | ArrayBuffer | Blob | ReadableStream.
      // Convert Buffer → ArrayBuffer (slice to detach from the underlying SharedArrayBuffer).
      const ab = bundle.buffer.slice(bundle.byteOffset, bundle.byteOffset + bundle.byteLength) as ArrayBuffer;
      await sandbox.files.write("/tmp/harness.cjs", ab);

      log(`spawning node /tmp/harness.cjs`);
      // Run in background; capture stdout/stderr to logs.
      void sandbox.commands.run(
        `node /tmp/harness.cjs`,
        {
          envs: { ...opts.envs, PORT: String(HARNESS_PORT) },
          background: true,
          onStdout: (data) => log(`[harness:stdout] ${data}`),
          onStderr: (data) => log(`[harness:stderr] ${data}`),
        },
      );

      const host = sandbox.getHost(HARNESS_PORT);
      const baseUrl = `https://${host}`;
      log(`port-forwarded ${HARNESS_PORT} → ${baseUrl}`);

      await waitForHealth(
        baseUrl,
        this.opts.readinessPollMs ?? 500,
        this.opts.readinessTimeoutMs ?? 60_000,
        log,
      );

      let killed = false;
      return {
        baseUrl,
        shutdown: async () => {
          if (killed) return;
          killed = true;
          log(`shutting down sandbox`);
          await sandbox.kill();
        },
      };
    } catch (err) {
      // Best-effort cleanup if anything past sandbox creation failed.
      try {
        await sandbox.kill();
      } catch {
        /* ignore */
      }
      throw err;
    }
  }
}

async function waitForHealth(
  baseUrl: string,
  pollMs: number,
  timeoutMs: number,
  log: (s: string) => void,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;
  while (Date.now() < deadline) {
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
  throw new Error(`E2BSubstrate: harness did not become healthy within ${timeoutMs}ms`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
