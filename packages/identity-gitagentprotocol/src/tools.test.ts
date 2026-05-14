import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadGapTools } from "./tools.js";

let workdir: string;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "gap-tools-"));
});
afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

async function tool(name: string, body: string): Promise<void> {
  await mkdir(join(workdir, "tools"), { recursive: true });
  await writeFile(join(workdir, "tools", `${name}.yaml`), body);
}

describe("loadGapTools", () => {
  it("returns empty when no tools/ directory exists", async () => {
    const result = await loadGapTools(workdir);
    expect(result.allowedTools).toEqual([]);
    expect(result.mcpServer).toBeUndefined();
    expect(result.mcpToolNames).toEqual([]);
  });

  it("translates implementation.builtin to allowedTools", async () => {
    await tool("read_file", `
name: read_file
description: alias for Read
implementation:
  builtin: Read
`);
    await tool("edit", `
name: edit
implementation:
  builtin: Edit
`);
    const result = await loadGapTools(workdir);
    expect(result.allowedTools.sort()).toEqual(["Edit", "Read"]);
    expect(result.mcpServer).toBeUndefined();
  });

  it("wraps script tools in an in-process MCP server", async () => {
    await tool("greet", `
name: greet
description: Print a greeting
parameters:
  type: object
  properties:
    name:
      type: string
  required: [name]
implementation:
  script:
    command: bash
    args: ["-c", "echo hello $NAME"]
`);
    const result = await loadGapTools(workdir);
    expect(result.allowedTools).toEqual([]);
    expect(result.mcpServer?.type).toBe("sdk");
    expect(result.mcpServer?.name).toBe("gap_tools");
    expect(result.mcpToolNames).toEqual(["mcp__gap_tools__greet"]);
  });

  it("mixed builtin + script tools — both surfaces populated", async () => {
    await tool("read_file", `
name: read_file
implementation:
  builtin: Read
`);
    await tool("greet", `
name: greet
parameters:
  type: object
  properties:
    name: { type: string }
implementation:
  script:
    command: echo
    args: ["hi"]
`);
    const result = await loadGapTools(workdir);
    expect(result.allowedTools).toContain("Read");
    expect(result.mcpToolNames).toContain("mcp__gap_tools__greet");
    expect(result.mcpServer).toBeDefined();
  });

  it("malformed YAML files are skipped silently", async () => {
    await tool("broken", "this: is: : invalid:\n  - yaml");
    await tool("ok", `
name: ok
implementation:
  builtin: Read
`);
    const result = await loadGapTools(workdir);
    expect(result.allowedTools).toEqual(["Read"]);
  });

  it("tool without builtin or script is ignored", async () => {
    await tool("empty", `
name: empty
implementation: {}
`);
    const result = await loadGapTools(workdir);
    expect(result.allowedTools).toEqual([]);
    expect(result.mcpServer).toBeUndefined();
  });

  it("ignores files that are not .yaml/.yml", async () => {
    await mkdir(join(workdir, "tools"), { recursive: true });
    await writeFile(join(workdir, "tools", "README.md"), "# tools");
    const result = await loadGapTools(workdir);
    expect(result.allowedTools).toEqual([]);
  });
});

describe("script tool execution (end-to-end via MCP handler)", () => {
  it("script tool's handler runs the command and returns stdout", async () => {
    await tool("greet", `
name: greet
parameters:
  type: object
  properties:
    name:
      type: string
  required: [name]
implementation:
  script:
    command: bash
    args: ["-c", "echo hello $NAME"]
`);
    const result = await loadGapTools(workdir);
    const inst = result.mcpServer!.instance as unknown as {
      _registeredTools: Record<string, { handler: (args: unknown) => Promise<unknown> }>;
    };
    // McpServer stores tools internally; reach into the instance for test purposes.
    const tools = inst._registeredTools;
    const greet = tools["greet"];
    expect(greet).toBeDefined();
    const out = (await greet!.handler({ name: "world" })) as { content: { text: string }[] };
    expect(out.content[0]?.text.trim()).toBe("hello world");
  });

  it("non-zero exit code returns isError: true", async () => {
    await tool("fail", `
name: fail
implementation:
  script:
    command: bash
    args: ["-c", "exit 7"]
`);
    const result = await loadGapTools(workdir);
    const inst = result.mcpServer!.instance as unknown as {
      _registeredTools: Record<string, { handler: (args: unknown) => Promise<unknown> }>;
    };
    const out = (await inst._registeredTools["fail"]!.handler({})) as { isError?: boolean };
    expect(out.isError).toBe(true);
  });
});
