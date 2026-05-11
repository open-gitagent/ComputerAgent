/**
 * Substrate — abstraction over WHERE the harness server runs.
 *
 * `runtime: "local"` (default) means "the harness server is already up at
 * `harnessUrl`, just talk to it." A non-trivial Substrate (e.g. E2B) boots
 * the server inside a sandbox/container, exposes a URL, and tears it down
 * on shutdown. The SDK calls `bootHarness()` lazily on the first chat()
 * and reuses the URL for all subsequent calls on the same agent.
 *
 * Implementing the interface = "I can run a harness server somewhere and
 * give you back a URL." That's the whole contract.
 */
export interface Substrate {
  /** Boot a harness server somewhere and return how to reach it. */
  bootHarness(opts: BootHarnessOptions): Promise<BootedHarness>;
}

export interface BootHarnessOptions {
  /**
   * Env vars the engine needs (e.g. ANTHROPIC_API_KEY). The substrate is
   * responsible for getting these into the sandbox safely. Treat as secrets.
   */
  readonly envs: Readonly<Record<string, string>>;
  /** Optional logical name for the boot (used by some substrates for naming). */
  readonly label?: string;
}

export interface BootedHarness {
  /** Base URL of the running harness server (no trailing slash). */
  readonly baseUrl: string;
  /** Tear down the substrate. Idempotent. */
  shutdown(): Promise<void>;
}
