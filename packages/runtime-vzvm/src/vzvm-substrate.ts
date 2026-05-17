import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { NodeSSH } from "node-ssh";
import type { BootHarnessOptions, BootedHarness, Substrate } from "@computeragent/sdk";
import { createLogger } from "@computeragent/protocol";
import { tartClone, tartDelete, tartIp, tartRunBackground, tartStop } from "./tart.js";

const HARNESS_PORT = 7700;
const BUNDLE_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../assets/harness-bundle.mjs");
const SANDBOX_PKG_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../assets/sandbox-package.json");

export interface VZVMSubstrateOptions {
  /** Base image pulled via `tart pull`. Example: "ghcr.io/cirruslabs/ubuntu:latest". */
  readonly baseImage: string;
  /** SSH username for the base image. Cirruslabs Ubuntu uses "admin". */
  readonly sshUser?: string;
  /** SSH password. Cirruslabs Ubuntu default: "admin". Prefer key-based auth. */
  readonly sshPassword?: string;
  /** SSH private key path (PEM). Used instead of password if both are set. */
  readonly sshPrivateKeyPath?: string;
  /** Path to the tart binary. Default: resolved via PATH. */
  readonly tartBin?: string;
  /** Path to where the harness bundle is shipped onto the VM. */
  readonly remoteWorkdir?: string;
  /** Override the local bundle path (for tests / forks). */
  readonly bundlePath?: string;
  /** Polling interval (ms) for VM IP + /v1/health. */
  readonly readinessPollMs?: number;
  /** Max ms to wait for VM IP + harness /v1/health. */
  readonly readinessTimeoutMs?: number;
  /** Single-line log callback. */
  readonly onLog?: (line: string) => void;
}

/**
 * Boots the harness server inside a VZVirtualMachine via Tart.
 *
 * Prereqs (one-time):
 *   - macOS on Apple Silicon
 *   - `brew install cirruslabs/cli/tart`
 *   - `tart pull ghcr.io/cirruslabs/ubuntu:latest`
 *
 * Per-bootHarness() call:
 *   1. tart clone <baseImage> <ephemeral-name>
 *   2. tart run <ephemeral-name>            (background)
 *   3. tart ip <ephemeral-name>              (poll until VM is up)
 *   4. ssh: scp bundle + package.json into the VM
 *   5. ssh: `npm install` (pulls @anthropic-ai/claude-agent-sdk's native binary)
 *   6. ssh: spawn `node harness.mjs` in background
 *   7. Poll http://<vm-ip>:7700/v1/health until ready
 *   8. Return { baseUrl, shutdown }. shutdown stops + deletes the VM.
 *
 * Same Substrate interface as runtime-e2b and runtime-local — caller's SDK code
 * is identical except for the `runtime` field.
 */
export class VZVMSubstrate implements Substrate {
  constructor(private readonly opts: VZVMSubstrateOptions) {}

  async bootHarness(opts: BootHarnessOptions): Promise<BootedHarness> {
    const log = this.opts.onLog ?? defaultOnLog;
    const logger = createLogger({ component: "substrate.vzvm" });
    const sshUser = this.opts.sshUser ?? "admin";
    const remoteWorkdir = this.opts.remoteWorkdir ?? `/home/${sshUser}/harness`;
    const tartBin = { tartBin: this.opts.tartBin };
    const name = `ca-${randomBytes(4).toString("hex")}`;

    logger.info("vm.clone", { runtime: "vzvm", baseImage: this.opts.baseImage, newVm: name });
    await tartClone(this.opts.baseImage, name, tartBin);

    logger.info("vm.start", { runtime: "vzvm", vm: name });
    let vmProcess = tartRunBackground(name, tartBin);
    let shutdownCalled = false;
    const cleanup = async () => {
      if (shutdownCalled) return;
      shutdownCalled = true;
      logger.info("dispose", { runtime: "vzvm", vm: name });
      try {
        await tartStop(name, tartBin);
      } catch (err) {
        log(`tart stop failed (continuing): ${(err as Error).message}`);
      }
      try {
        vmProcess.kill();
      } catch {
        /* ignore */
      }
      try {
        await tartDelete(name, tartBin);
      } catch (err) {
        log(`tart delete failed: ${(err as Error).message}`);
      }
    };

    try {
      const ip = await waitForIp(name, tartBin, this.opts.readinessPollMs ?? 1_000, this.opts.readinessTimeoutMs ?? 120_000);
      logger.info("vm.ip", { runtime: "vzvm", vm: name, ip });

      const ssh = new NodeSSH();
      await waitForSsh(ssh, ip, sshUser, this.opts, log, this.opts.readinessTimeoutMs ?? 60_000);
      logger.info("ssh.ready", { runtime: "vzvm", ip });

      const bundlePath = this.opts.bundlePath ?? BUNDLE_PATH;
      const uploadStart = Date.now();
      await ssh.execCommand(`mkdir -p ${shellEscape(remoteWorkdir)}`);
      await ssh.putFiles([
        { local: bundlePath, remote: `${remoteWorkdir}/harness.mjs` },
        { local: SANDBOX_PKG_PATH, remote: `${remoteWorkdir}/package.json` },
      ]);
      logger.info("upload", { runtime: "vzvm", remoteWorkdir, durationMs: Date.now() - uploadStart });

      await ensureNode(ssh, log);

      const installStart = Date.now();
      const install = await ssh.execCommand(
        `cd ${shellEscape(remoteWorkdir)} && npm install --include=optional --no-fund --no-audit`,
        { execOptions: { pty: false } },
      );
      if (install.code !== 0) {
        logger.error("install.failed", { runtime: "vzvm", code: install.code });
        throw new Error(`npm install failed (code ${install.code}): ${install.stderr.slice(0, 800)}`);
      }
      logger.info("install.ok", { runtime: "vzvm", durationMs: Date.now() - installStart });

      logger.info("spawn", { runtime: "vzvm", cmd: "node harness.mjs" });
      const envExports = renderEnvExports(opts.envs);
      // `setsid -f` forks before calling setsid(2): the parent (visible to
      // ssh.execCommand) returns immediately, while the child becomes a new
      // session leader fully detached from the SSH channel. `&` + `disown`
      // and bare `( cmd & )` both leave the top-level bash blocking the
      // exec channel from closing; setsid -f is the only idiom that
      // reliably releases it on Ubuntu without sudo.
      const startCmd =
        `cd ${shellEscape(remoteWorkdir)} && ` +
        `${envExports} PORT=${HARNESS_PORT} ` +
        `setsid -f node harness.mjs </dev/null >/tmp/harness.log 2>&1`;
      await ssh.execCommand(startCmd);

      const baseUrl = `http://${ip}:${HARNESS_PORT}`;
      await waitForHealth(baseUrl, this.opts.readinessPollMs ?? 500, this.opts.readinessTimeoutMs ?? 60_000, log);
      logger.info("harness.ready", { runtime: "vzvm", url: baseUrl });

      ssh.dispose();
      return {
        baseUrl,
        shutdown: cleanup,
      };
    } catch (err) {
      logger.error("boot_failed", {
        runtime: "vzvm",
        vm: name,
        error: err instanceof Error ? err.message : String(err),
      });
      await cleanup();
      throw err;
    }
  }
}

/**
 * Default onLog: forward every captured line to OUR stderr unchanged. The
 * VZ VM streams harness logs over SSH stderr — relaying preserves structure.
 */
function defaultOnLog(line: string): void {
  try {
    process.stderr.write(line + "\n");
  } catch {
    /* swallow */
  }
}

// ── helpers ──────────────────────────────────────────────────────────────

async function waitForIp(
  name: string,
  tartBin: { tartBin: string | undefined },
  pollMs: number,
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const ip = await tartIp(name, tartBin);
      if (ip) return ip;
    } catch {
      /* not ready yet */
    }
    await sleep(pollMs);
  }
  throw new Error(`VZVMSubstrate: VM ${name} did not get an IP within ${timeoutMs}ms`);
}

async function waitForSsh(
  ssh: NodeSSH,
  ip: string,
  username: string,
  opts: VZVMSubstrateOptions,
  log: (s: string) => void,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      await ssh.connect({
        host: ip,
        username,
        password: opts.sshPassword,
        privateKeyPath: opts.sshPrivateKeyPath,
        tryKeyboard: !!opts.sshPassword,
      });
      log(`ssh connected to ${ip}`);
      return;
    } catch (err) {
      lastErr = err;
      await sleep(1_000);
    }
  }
  throw new Error(`VZVMSubstrate: SSH to ${ip} failed within ${timeoutMs}ms: ${(lastErr as Error)?.message}`);
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
  throw new Error(`VZVMSubstrate: harness did not become healthy within ${timeoutMs}ms`);
}

async function ensureNode(ssh: NodeSSH, log: (s: string) => void): Promise<void> {
  const check = await ssh.execCommand("command -v node >/dev/null && node -v || true");
  const installed = check.stdout.trim();
  if (installed.startsWith("v20.") || installed.startsWith("v22.")) {
    log(`node already present: ${installed}`);
    return;
  }
  log(`installing Node 20 via NodeSource (one-time per VM, ~30s)`);
  const setup = await ssh.execCommand(
    "curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && " +
      "sudo apt-get install -y nodejs",
    { execOptions: { pty: false } },
  );
  if (setup.code !== 0) {
    throw new Error(`node install failed (code ${setup.code}): ${setup.stderr.slice(0, 800)}`);
  }
  const verify = await ssh.execCommand("node -v && npm -v");
  log(`node installed: ${verify.stdout.trim().replace(/\n/g, " / npm ")}`);
}

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function renderEnvExports(envs: Readonly<Record<string, string>>): string {
  return Object.entries(envs)
    .map(([k, v]) => `${k}=${shellEscape(v)}`)
    .join(" ");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
