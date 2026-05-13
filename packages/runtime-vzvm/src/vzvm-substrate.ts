import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { NodeSSH } from "node-ssh";
import type { BootHarnessOptions, BootedHarness, Substrate } from "@computeragent/sdk";
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
    const log = this.opts.onLog ?? (() => {});
    const sshUser = this.opts.sshUser ?? "admin";
    const remoteWorkdir = this.opts.remoteWorkdir ?? "/home/admin/harness";
    const tartBin = { tartBin: this.opts.tartBin };
    const name = `ca-${randomBytes(4).toString("hex")}`;

    log(`tart clone ${this.opts.baseImage} ${name}`);
    await tartClone(this.opts.baseImage, name, tartBin);

    let vmProcess = tartRunBackground(name, tartBin);
    let shutdownCalled = false;
    const cleanup = async () => {
      if (shutdownCalled) return;
      shutdownCalled = true;
      log(`tart stop + delete ${name}`);
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
      log(`waiting for VM IP`);
      const ip = await waitForIp(name, tartBin, this.opts.readinessPollMs ?? 1_000, this.opts.readinessTimeoutMs ?? 120_000);
      log(`VM up at ${ip}`);

      const ssh = new NodeSSH();
      await waitForSsh(ssh, ip, sshUser, this.opts, log, this.opts.readinessTimeoutMs ?? 60_000);

      const bundlePath = this.opts.bundlePath ?? BUNDLE_PATH;
      log(`mkdir + scp bundle + package.json → ${remoteWorkdir}`);
      await ssh.execCommand(`mkdir -p ${shellEscape(remoteWorkdir)}`);
      const bundle = await readFile(bundlePath);
      const pkg = await readFile(SANDBOX_PKG_PATH);
      await ssh.putFiles([
        { local: bundlePath, remote: `${remoteWorkdir}/harness.mjs` },
        { local: SANDBOX_PKG_PATH, remote: `${remoteWorkdir}/package.json` },
      ]);
      // Touch the files to mark them as fresh (and verify connectivity).
      void bundle; void pkg;

      log(`npm install (Claude Agent SDK + native binary)`);
      const install = await ssh.execCommand(
        `cd ${shellEscape(remoteWorkdir)} && npm install --include=optional --no-fund --no-audit`,
        { execOptions: { pty: false } },
      );
      if (install.code !== 0) {
        throw new Error(`npm install failed (code ${install.code}): ${install.stderr.slice(0, 800)}`);
      }

      log(`spawning node harness.mjs`);
      const envExports = renderEnvExports(opts.envs);
      const startCmd = `cd ${shellEscape(remoteWorkdir)} && ${envExports} PORT=${HARNESS_PORT} nohup node harness.mjs > /tmp/harness.log 2>&1 &`;
      await ssh.execCommand(startCmd);

      const baseUrl = `http://${ip}:${HARNESS_PORT}`;
      await waitForHealth(baseUrl, this.opts.readinessPollMs ?? 500, this.opts.readinessTimeoutMs ?? 60_000, log);

      ssh.dispose();
      return {
        baseUrl,
        shutdown: cleanup,
      };
    } catch (err) {
      await cleanup();
      throw err;
    }
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
