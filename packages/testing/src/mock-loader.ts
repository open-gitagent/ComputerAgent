import type { IdentityLoader, IdentityLoadResult } from "@computeragent/protocol";

/** Canned response from MockLoader.load(); override per test. */
export interface MockLoaderConfig {
  readonly options?: unknown;
  readonly metadata?: { name: string; version: string; sha?: string };
}

/**
 * Deterministic IdentityLoader for tests. Returns whatever was configured;
 * does not touch the filesystem or network.
 */
export class MockLoader implements IdentityLoader<unknown> {
  readonly name = "mock";
  private cleanedUp = false;

  constructor(private readonly config: MockLoaderConfig = {}) {}

  async load(): Promise<IdentityLoadResult<unknown>> {
    return {
      options: this.config.options ?? {},
      metadata: this.config.metadata ?? { name: "mock-agent", version: "0.0.0" },
      cleanup: async () => {
        this.cleanedUp = true;
      },
    };
  }

  /** Test introspection: did the harness-server call our cleanup hook? */
  get wasCleanedUp(): boolean {
    return this.cleanedUp;
  }
}
