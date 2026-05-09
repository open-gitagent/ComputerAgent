import { mkdtemp, mkdir, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitAgentProtocolLoader } from "./loader.js";

let workdir: string;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "gitagentprotocol-loader-test-"));
});
afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

async function fixtureGap(root: string): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, "agent.yaml"),
    [
      'spec_version: "0.1.0"',
      "name: test-agent",
      "version: 1.0.0",
      "description: A test agent",
      "model:",
      "  preferred: claude-opus-4-7",
      "runtime:",
      "  max_turns: 25",
      "  budget_usd: 2.5",
    ].join("\n"),
    "utf8",
  );
  await writeFile(join(root, "SOUL.md"), "# Soul\nI am a careful test agent.", "utf8");
  await writeFile(join(root, "RULES.md"), "# Rules\nDo not delete files.", "utf8");
  await mkdir(join(root, "skills", "code-review"), { recursive: true });
  await writeFile(
    join(root, "skills", "code-review", "SKILL.md"),
    "---\nname: code-review\ndescription: Review code\n---\n",
    "utf8",
  );
}

describe("GitAgentProtocolLoader", () => {
  it("loads a local GAP repo and produces ClaudeAgentOptions", async () => {
    const repo = join(workdir, "repo");
    await fixtureGap(repo);
    const dest = join(workdir, "session");

    const loader = new GitAgentProtocolLoader();
    const result = await loader.load({
      source: { type: "local", path: repo },
      targetEngine: "claude-agent-sdk",
      workdir: dest,
    });

    expect(result.metadata.name).toBe("test-agent");
    expect(result.metadata.version).toBe("1.0.0");

    const opts = result.options as Record<string, unknown>;
    expect(opts.model).toBe("claude-opus-4-7");
    expect(opts.maxTurns).toBe(25);
    expect(opts.maxBudgetUsd).toBe(2.5);

    const sysPrompt = opts.systemPrompt as { type: string; preset: string; append: string };
    expect(sysPrompt.type).toBe("preset");
    expect(sysPrompt.preset).toBe("claude_code");
    expect(sysPrompt.append).toContain("test-agent");
    expect(sysPrompt.append).toContain("careful test agent");
    expect(sysPrompt.append).toContain("Do not delete files");
  });

  it("mirrors skills/ to .claude/skills/", async () => {
    const repo = join(workdir, "repo");
    await fixtureGap(repo);
    const dest = join(workdir, "session");

    const loader = new GitAgentProtocolLoader();
    await loader.load({
      source: { type: "local", path: repo },
      targetEngine: "claude-agent-sdk",
      workdir: dest,
    });

    const mirrored = await stat(join(dest, ".claude", "skills", "code-review", "SKILL.md"));
    expect(mirrored.isFile()).toBe(true);
  });

  it("rejects unknown target engine", async () => {
    const repo = join(workdir, "repo");
    await fixtureGap(repo);

    const loader = new GitAgentProtocolLoader();
    await expect(
      loader.load({
        source: { type: "local", path: repo },
        targetEngine: "nonexistent",
        workdir: join(workdir, "session"),
      }),
    ).rejects.toThrow(/no adapter/);
  });

  it("rejects malformed agent.yaml", async () => {
    const repo = join(workdir, "repo");
    await mkdir(repo, { recursive: true });
    await writeFile(join(repo, "agent.yaml"), "this: is: not: valid: yaml: at: all:", "utf8");

    const loader = new GitAgentProtocolLoader();
    await expect(
      loader.load({
        source: { type: "local", path: repo },
        targetEngine: "claude-agent-sdk",
        workdir: join(workdir, "session"),
      }),
    ).rejects.toThrow();
  });

  it("inline source materializes manifest + files", async () => {
    const dest = join(workdir, "session");
    const loader = new GitAgentProtocolLoader();
    const result = await loader.load({
      source: {
        type: "inline",
        manifest: { name: "x", version: "0.0.1" },
        files: {
          "agent.yaml": "name: inline-agent\nversion: 0.0.2",
          "SOUL.md": "# Soul\nFrom inline.",
        },
      },
      targetEngine: "claude-agent-sdk",
      workdir: dest,
    });
    expect(result.metadata.name).toBe("inline-agent");
    expect(result.metadata.version).toBe("0.0.2");
  });
});
