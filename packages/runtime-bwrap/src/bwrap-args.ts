/**
 * Pure argv builder for `bwrap`.
 *
 * Separated from the substrate (which deals with spawning + lifecycle) so we
 * can unit-test the argv without `bwrap` installed and so the isolation
 * policy is a single readable block of code.
 *
 * The argv produced ends with `--`, the node binary, the harness bundle path.
 * Caller invokes: `spawn("bwrap", argv, ...)`.
 */

export interface BwrapArgsOptions {
  /** Absolute path on the host to the harness bundle (.mjs). Bind-mounted read-only. */
  readonly bundlePath: string;
  /** Absolute path on the host to the node binary. Bind-mounted read-only. */
  readonly nodePath: string;
  /** Absolute path on the host to the per-session workdir. Bind-mounted read-write. */
  readonly workdir: string;
  /** Port the harness listens on inside the sandbox. */
  readonly port: number;
  /** Env vars forwarded into the sandbox via repeated --setenv. */
  readonly envs: Readonly<Record<string, string>>;
  /**
   * Share the host network namespace. Default `true` — agents need outbound
   * HTTPS (Anthropic API, exa, etc.). Set false for hermetic mode.
   */
  readonly shareNetwork?: boolean;
  /**
   * Extra read-only bind-mounts beyond the defaults. Use to expose specific
   * tools (e.g. `{ src: "/opt/python3" }` for Python at a non-standard prefix).
   * If `dest` is omitted, mirrors `src`.
   */
  readonly extraRoBinds?: ReadonlyArray<{ src: string; dest?: string }>;
}

/**
 * Build the argv for `bwrap`. The returned array is ready to pass to
 * `child_process.spawn("bwrap", argv)`.
 *
 * The policy:
 *   - Unshare every namespace (mount, PID, IPC, UTS, user, cgroup).
 *   - Share net (--share-net) so agents can reach the Anthropic API. Set
 *     `shareNetwork: false` for hermetic runs.
 *   - Drop ALL Linux capabilities. The agent inherits the user namespace's
 *     root view but holds zero real capabilities.
 *   - Bind /usr, /lib, /lib64, /bin read-only (system tooling + glibc).
 *   - Bind /etc/resolv.conf + /etc/ssl read-only (DNS + TLS roots for HTTPS).
 *   - Synthetic /proc and minimal /dev.
 *   - Private tmpfs for /tmp and /var/tmp.
 *   - The per-session workdir is bind-mounted read-write at /workdir.
 *   - The harness bundle is bind-mounted read-only at /harness/harness.mjs.
 *   - HOME=/workdir so tools that fall back to $HOME (pip, gitclaw, ...) write
 *     into the writable jail rather than failing.
 */
export function buildBwrapArgs(opts: BwrapArgsOptions): string[] {
  const args: string[] = [];

  // Namespaces + lifecycle
  args.push("--unshare-all");
  if (opts.shareNetwork ?? true) args.push("--share-net");
  args.push("--die-with-parent");
  args.push("--new-session");

  // Drop all Linux capabilities. bwrap exposes this via --cap-drop.
  // Passing "ALL" makes the empty set explicit.
  args.push("--cap-drop", "ALL");

  // Read-only system layout
  for (const path of ["/usr", "/lib", "/lib64", "/bin", "/sbin"]) {
    args.push("--ro-bind-try", path, path);
  }
  // DNS + TLS roots — minimum needed for outbound HTTPS to work.
  args.push("--ro-bind-try", "/etc/resolv.conf", "/etc/resolv.conf");
  args.push("--ro-bind-try", "/etc/ssl", "/etc/ssl");
  args.push("--ro-bind-try", "/etc/ca-certificates", "/etc/ca-certificates");
  args.push("--ro-bind-try", "/etc/pki", "/etc/pki");

  // Caller-supplied extra read-only mounts.
  for (const entry of opts.extraRoBinds ?? []) {
    args.push("--ro-bind", entry.src, entry.dest ?? entry.src);
  }

  // Per-namespace synthetic filesystems
  args.push("--proc", "/proc");
  args.push("--dev", "/dev");
  args.push("--tmpfs", "/tmp");
  args.push("--tmpfs", "/var/tmp");

  // Writable session workdir (read-write bind). This is the ONLY writable
  // path the agent has (besides /tmp, which is a private tmpfs scoped to
  // this namespace and discarded on exit).
  args.push("--bind", opts.workdir, "/workdir");

  // Harness bundle (read-only). Mount at a stable path so the launch line
  // doesn't change per-session.
  args.push("--ro-bind", opts.bundlePath, "/harness/harness.mjs");

  // Node binary (read-only). bwrap doesn't automatically expose the host
  // node — we bind the specific binary the parent is running.
  args.push("--ro-bind", opts.nodePath, "/usr/local/bin/node");

  // Working directory inside the sandbox
  args.push("--chdir", "/workdir");

  // Environment. Order matters only insofar as a later --setenv wins; we
  // emit a sane PATH first then layer caller-supplied envs on top.
  args.push("--setenv", "PATH", "/usr/local/bin:/usr/bin:/bin");
  args.push("--setenv", "HOME", "/workdir");
  args.push("--setenv", "PORT", String(opts.port));
  // Force loopback binding inside the sandbox; the host can still reach it
  // via the shared net namespace (when --share-net is on).
  args.push("--setenv", "HARNESS_BIND", "127.0.0.1");
  for (const [k, v] of Object.entries(opts.envs)) {
    args.push("--setenv", k, v);
  }

  // The command to run inside the sandbox.
  args.push("--", "/usr/local/bin/node", "/harness/harness.mjs");

  return args;
}
