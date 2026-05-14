import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadGapSubagents } from "./subagents.js";

let workdir: string;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "gap-subagents-"));
});
afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

async function inlineAgent(name: string, body: string): Promise<void> {
  await mkdir(join(workdir, "agents"), { recursive: true });
  await writeFile(join(workdir, "agents", `${name}.yaml`), body);
}

async function nestedAgent(name: string, manifest: string | null, soul: string | null): Promise<void> {
  const dir = join(workdir, "agents", name);
  await mkdir(dir, { recursive: true });
  if (manifest !== null) await writeFile(join(dir, "agent.yaml"), manifest);
  if (soul !== null) await writeFile(join(dir, "SOUL.md"), soul);
}

describe("loadGapSubagents", () => {
  it("returns empty when no agents/ directory exists", async () => {
    expect(await loadGapSubagents(workdir)).toEqual({});
  });

  it("loads an inline agents/<name>.yaml", async () => {
    await inlineAgent("reviewer", `
description: Reviews pull requests for security issues
prompt: |
  You are a security-focused PR reviewer.
  Flag any unsafe code patterns.
model: sonnet
tools: [Read, Grep]
disallowed_tools: [Bash]
`);
    const agents = await loadGapSubagents(workdir);
    expect(agents.reviewer).toBeDefined();
    expect(agents.reviewer?.description).toBe("Reviews pull requests for security issues");
    expect(agents.reviewer?.prompt).toContain("security-focused PR reviewer");
    expect(agents.reviewer?.model).toBe("sonnet");
    expect(agents.reviewer?.tools).toEqual(["Read", "Grep"]);
    expect(agents.reviewer?.disallowedTools).toEqual(["Bash"]);
  });

  it("loads a nested agents/<name>/ with agent.yaml + SOUL.md", async () => {
    await nestedAgent(
      "researcher",
      `
name: researcher
version: 0.1.0
description: Researches topics by reading the web
model:
  preferred: claude-opus-4-7
tools: [WebFetch, Read]
`,
      `# Soul
You are a careful researcher.
Always cite sources.
`,
    );
    const agents = await loadGapSubagents(workdir);
    expect(agents.researcher).toBeDefined();
    expect(agents.researcher?.description).toBe("Researches topics by reading the web");
    expect(agents.researcher?.prompt).toContain("You are a careful researcher");
    expect(agents.researcher?.model).toBe("claude-opus-4-7");
    expect(agents.researcher?.tools).toEqual(["WebFetch", "Read"]);
  });

  it("nested agent without SOUL.md is skipped (no prompt = no agent)", async () => {
    await nestedAgent("incomplete", "description: missing SOUL.md", null);
    const agents = await loadGapSubagents(workdir);
    expect(agents.incomplete).toBeUndefined();
  });

  it("nested agent with SOUL.md but no agent.yaml gets default description", async () => {
    await nestedAgent("just-soul", null, "# Soul\nDo the thing.");
    const agents = await loadGapSubagents(workdir);
    expect(agents["just-soul"]).toBeDefined();
    expect(agents["just-soul"]?.description).toBe("Sub-agent");
    expect(agents["just-soul"]?.prompt).toContain("Do the thing.");
  });

  it("inline agent missing 'description' or 'prompt' is skipped", async () => {
    await inlineAgent("bad", "model: sonnet\ntools: [Read]");
    const agents = await loadGapSubagents(workdir);
    expect(agents.bad).toBeUndefined();
  });

  it("mixes inline and nested agents in the same agents/ dir", async () => {
    await inlineAgent("quick", `
description: Quick inline agent
prompt: Do it fast.
`);
    await nestedAgent("deep", "description: deep nested\n", "# Soul\nthink.");
    const agents = await loadGapSubagents(workdir);
    expect(Object.keys(agents).sort()).toEqual(["deep", "quick"]);
  });

  it("malformed yaml file is skipped without breaking sibling loads", async () => {
    await inlineAgent("broken", "::: not yaml :::");
    await inlineAgent("ok", `
description: Working
prompt: Do work.
`);
    const agents = await loadGapSubagents(workdir);
    expect(agents.broken).toBeUndefined();
    expect(agents.ok).toBeDefined();
  });

  it("non-yaml files at agents/ root are ignored", async () => {
    await mkdir(join(workdir, "agents"), { recursive: true });
    await writeFile(join(workdir, "agents", "README.md"), "# agents");
    expect(await loadGapSubagents(workdir)).toEqual({});
  });
});
