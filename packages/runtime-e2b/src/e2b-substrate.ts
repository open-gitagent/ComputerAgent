import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { Sandbox } from "e2b";
import type { BootHarnessOptions, BootedHarness, Substrate } from "@computeragent/sdk";

/** Default port the harness server listens on inside the sandbox. */
const HARNESS_PORT = 7700;

/** Where the harness bundle lives relative to dist/ after `pnpm build`. */
const BUNDLE_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../assets/harness-bundle.mjs");
/** Tiny package.json with `@anthropic-ai/claude-agent-sdk` declared as a dep. */
const SANDBOX_PKG_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../assets/sandbox-package.json");

/** Where everything lands inside the sandbox. User-writable in E2B's default. */
const SANDBOX_DIR = "/home/user/harness";

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
 *   2. Upload the harness bundle + a tiny package.json to /opt/harness/.
 *   3. `npm install` inside /opt/harness — pulls @anthropic-ai/claude-agent-sdk
 *      with its platform-specific native binary (linux-x64). We mark the SDK
 *      `external` in the bundle so the bundled .cjs `require()`s the freshly
 *      installed module from /opt/harness/node_modules.
 *   4. Spawn `node /opt/harness/harness.mjs` with the caller's envs.
 *   5. Poll the public port-forwarded URL for `/v1/health` until ready.
 *   6. Return `{ baseUrl, shutdown }`. SDK uses baseUrl just like localhost.
 *
 * Wedge 3b.5 will replace step 3 with a pre-built E2B template that has the
 * SDK installed at template-build time (saving ~10–30s per boot).
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
      log(`uploading harness bundle + package.json`);
      const bundlePath = this.opts.bundlePath ?? BUNDLE_PATH;
      const bundle = await readFile(bundlePath);
      const pkgJson = await readFile(SANDBOX_PKG_PATH, "utf8");
      // Buffer → ArrayBuffer (slice detaches from the underlying memory).
      const ab = bundle.buffer.slice(bundle.byteOffset, bundle.byteOffset + bundle.byteLength) as ArrayBuffer;

      await sandbox.commands.run(`mkdir -p ${SANDBOX_DIR}`);
      await sandbox.files.write(`${SANDBOX_DIR}/harness.mjs`, ab);
      await sandbox.files.write(`${SANDBOX_DIR}/package.json`, pkgJson);

      log(`npm install (Claude Agent SDK + native binary)`);
      const install = await sandbox.commands.run(
        // --include=optional so the platform-specific native CLI binary lands.
        `cd ${SANDBOX_DIR} && npm install --include=optional --no-fund --no-audit`,
        { timeoutMs: 180_000 },
      );
      if (install.exitCode !== 0) {
        throw new Error(`npm install failed (exit ${install.exitCode}): ${install.stderr.slice(0, 1000)}`);
      }
      log(`npm install complete`);

      log(`spawning node harness.mjs`);
      void sandbox.commands.run(
        `cd ${SANDBOX_DIR} && node harness.mjs`,
        {
          envs: { ...opts.envs, PORT: String(HARNESS_PORT) },
          background: true,
          onStdout: (data) => log(`[harness:stdout] ${data.trimEnd()}`),
          onStderr: (data) => log(`[harness:stderr] ${data.trimEnd()}`),
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
