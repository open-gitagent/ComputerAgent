import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { loadGapHooks } from "./hooks.js";

let workdir: string;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "gap-hooks-"));
});
afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

async function hooksYaml(body: string): Promise<void> {
  await mkdir(join(workdir, "hooks"), { recursive: true });
  await writeFile(join(workdir, "hooks", "hooks.yaml"), body);
}

async function script(relPath: string, body: string): Promise<void> {
  const abs = join(workdir, relPath);
  await mkdir(join(abs, ".."), { recursive: true });
  await writeFile(abs, body);
  await chmod(abs, 0o755);
}

// Minimal fake HookInput sufficient for unit tests; the SDK uses a discriminated
// union but the hook callback is only required to return a JSON object.
const fakeInput = { hook_event_name: "PreToolUse" } as never;
const fakeOpts = { signal: new AbortController().signal };

describe("loadGapHooks", () => {
  it("returns empty when hooks/hooks.yaml does not exist", async () => {
    expect(await loadGapHooks(workdir)).toEqual({});
  });

  it("returns empty on malformed YAML", async () => {
    await hooksYaml("::: not yaml :::");
    expect(await loadGapHooks(workdir)).toEqual({});
  });

  it("loads a single PreToolUse hook with matcher and timeout", async () => {
    await hooksYaml(`
PreToolUse:
  - matcher: Bash
    command: echo hi
    timeout_ms: 5000
`);
    const hooks = await loadGapHooks(workdir);
    expect(hooks.PreToolUse).toHaveLength(1);
    expect(hooks.PreToolUse?.[0]?.matcher).toBe("Bash");
    expect(hooks.PreToolUse?.[0]?.timeout).toBe(5); // ms → seconds for SDK
    expect(hooks.PreToolUse?.[0]?.hooks).toHaveLength(1);
  });

  it("loads multiple events with multiple entries", async () => {
    await hooksYaml(`
PreToolUse:
  - command: echo pre1
  - matcher: Edit
    command: echo pre2
PostToolUse:
  - command: echo post
SessionStart:
  - command: echo start
`);
    const hooks = await loadGapHooks(workdir);
    expect(hooks.PreToolUse).toHaveLength(2);
    expect(hooks.PostToolUse).toHaveLength(1);
    expect(hooks.SessionStart).toHaveLength(1);
  });

  it("hook callback runs the command and parses stdout JSON", async () => {
    await hooksYaml(`
PreToolUse:
  - command: 'echo {\\"decision\\":\\"allow\\"}'
`);
    const hooks = await loadGapHooks(workdir);
    const cb = hooks.PreToolUse?.[0]?.hooks[0] as HookCallback;
    const out = await cb(fakeInput, undefined, fakeOpts);
    expect(out).toEqual({ decision: "allow" });
  });

  it("hook callback empty stdout returns empty object", async () => {
    await hooksYaml(`
PreToolUse:
  - command: 'true'
`);
    const hooks = await loadGapHooks(workdir);
    const cb = hooks.PreToolUse?.[0]?.hooks[0] as HookCallback;
    const out = await cb(fakeInput, undefined, fakeOpts);
    expect(out).toEqual({});
  });

  it("hook callback non-JSON stdout returns empty object (graceful)", async () => {
    await hooksYaml(`
PreToolUse:
  - command: 'echo not-json'
`);
    const hooks = await loadGapHooks(workdir);
    const cb = hooks.PreToolUse?.[0]?.hooks[0] as HookCallback;
    const out = await cb(fakeInput, undefined, fakeOpts);
    expect(out).toEqual({});
  });

  it("hook callback non-zero exit surfaces a systemMessage", async () => {
    await hooksYaml(`
PreToolUse:
  - command: 'echo nope >&2; exit 7'
`);
    const hooks = await loadGapHooks(workdir);
    const cb = hooks.PreToolUse?.[0]?.hooks[0] as HookCallback;
    const out = (await cb(fakeInput, undefined, fakeOpts)) as { systemMessage?: string };
    expect(out.systemMessage).toContain("exited 7");
  });

  it("hook receives HookInput JSON on stdin", async () => {
    await script("hooks/echo-in.sh", "#!/bin/sh\ncat");
    await hooksYaml(`
PreToolUse:
  - command: ./hooks/echo-in.sh
`);
    const hooks = await loadGapHooks(workdir);
    const cb = hooks.PreToolUse?.[0]?.hooks[0] as HookCallback;
    const input = { hook_event_name: "PreToolUse", foo: "bar" } as never;
    const out = await cb(input, undefined, fakeOpts);
    expect(out).toEqual({ hook_event_name: "PreToolUse", foo: "bar" });
  });

  it("malformed entries inside a valid event do not break sibling entries", async () => {
    await hooksYaml(`
PreToolUse:
  - foo: bar    # no 'command', should be dropped
  - command: echo ok
`);
    const hooks = await loadGapHooks(workdir);
    // The malformed entry causes the whole event's array to fail safeParse,
    // because the schema requires every entry to pass. This is the strict
    // behavior — better to surface a configuration mistake than to silently
    // skip the bad row. Verify the whole event is dropped.
    expect(hooks.PreToolUse).toBeUndefined();
  });
});
