import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { IdentityLoader, IdentityLoadResult } from "@open-gitagent/protocol";
import { GapManifest } from "./manifest.js";
import { materialize } from "./source-resolver.js";
import { mirrorSkillsForClaude } from "./skills.js";
import { gapToClaudeAgentOptions } from "./adapters/claude-agent-sdk.js";
import { gapToGitagentOptions } from "./adapters/gitagent.js";
import { gapToDeepAgentsOptions } from "./adapters/deepagents.js";

interface AdapterResult {
  options: unknown;
  harden: (merged: unknown) => unknown;
}
type AdapterFn = (manifest: GapManifest, workdir: string) => Promise<AdapterResult>;

const ADAPTERS: Record<string, AdapterFn> = {
  "claude-agent-sdk": gapToClaudeAgentOptions as AdapterFn,
  "gitagent": gapToGitagentOptions as AdapterFn,
  "deepagents": gapToDeepAgentsOptions as AdapterFn,
};

/**
 * GitAgentProtocol identity loader.
 *
 * Pipeline: source → materialize → validate manifest → run target-engine adapter.
 * Adapters fan out per target engine; new engines get added by extending ADAPTERS,
 * never by modifying the loader itself (Open/Closed in the small).
 */
export class GitAgentProtocolLoader implements IdentityLoader<unknown> {
  readonly name = "gitagentprotocol";

  async load(args: {
    source: import("@open-gitagent/protocol").IdentitySource;
    targetEngine: string;
    workdir: string;
  }): Promise<IdentityLoadResult<unknown>> {
    const repoPath = await materialize(args.source, args.workdir);
    const manifest = await this.readManifest(repoPath);

    const adapter = ADAPTERS[args.targetEngine];
    if (!adapter) {
      throw new Error(
        `identity-gitagentprotocol: no adapter for engine '${args.targetEngine}' (have: ${Object.keys(ADAPTERS).join(", ")})`,
      );
    }

    if (args.targetEngine === "claude-agent-sdk") {
      await mirrorSkillsForClaude(repoPath);
    }

    const { options, harden } = await adapter(manifest, repoPath);
    return {
      options,
      harden,
      metadata: {
        name: manifest.name,
        version: manifest.version,
      },
    };
  }

  private async readManifest(repoPath: string): Promise<GapManifest> {
    const raw = await readFile(join(repoPath, "agent.yaml"), "utf8");
    const parsed = parseYaml(raw);
    return GapManifest.parse(parsed);
  }
}
