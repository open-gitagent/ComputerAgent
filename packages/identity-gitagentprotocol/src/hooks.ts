/**
 * GAP hooks translator — reads `hooks/hooks.yaml` from a GAP repo and produces
 * the Claude Agent SDK's `hooks` option as JS callbacks. The on-disk command
 * is wrapped in a callback that:
 *
 *   1. spawns the command in the workdir,
 *   2. writes the SDK's HookInput JSON to its stdin,
 *   3. parses stdout as the SDK's HookJSONOutput,
 *   4. enforces the configured timeout (default 30s) by SIGKILL.
 *
 * GAP hooks.yaml shape (top-level keys = HookEvent names):
 *
 *   PreToolUse:
 *     - matcher: "Bash"
 *       command: ./hooks/check-bash.sh
 *       timeout_ms: 5000
 *   PostToolUse:
 *     - command: ./hooks/log.sh
 *   SessionStart:
 *     - command: bash -c "echo session $(date) >> /tmp/runs.log"
 *
 * The shape is intentionally lenient: unknown top-level event names are
 * forwarded to the SDK, which will silently ignore any event it doesn't know
 * about. We never throw on a malformed entry — bad rows are dropped.
 */
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type {
  HookCallback,
  HookCallbackMatcher,
  HookEvent,
} from "@anthropic-ai/claude-agent-sdk";

const HookEntry = z
  .object({
    matcher: z.string().optional(),
    command: z.string().min(1),
    timeout_ms: z.number().int().positive().optional(),
  })
  .passthrough();
type HookEntry = z.infer<typeof HookEntry>;

const HooksFile = z.record(z.string(), z.array(HookEntry));

export type HooksMap = Partial<Record<HookEvent, HookCallbackMatcher[]>>;

const DEFAULT_TIMEOUT_MS = 30_000;

export async function loadGapHooks(workdir: string): Promise<HooksMap> {
  const path = join(workdir, "hooks", "hooks.yaml");
  const raw = await readFileSafe(path);
  if (raw === null) return {};

  let yaml: unknown;
  try { yaml = parseYaml(raw); } catch { return {}; }

  const parsed = HooksFile.safeParse(yaml);
  if (!parsed.success) return {};

  const out: HooksMap = {};
  for (const [event, entries] of Object.entries(parsed.data)) {
    const matchers: HookCallbackMatcher[] = [];
    for (const entry of entries) {
      matchers.push(buildMatcher(entry, workdir));
    }
    if (matchers.length > 0) {
      (out as Record<string, HookCallbackMatcher[]>)[event] = matchers;
    }
  }
  return out;
}

function buildMatcher(entry: HookEntry, workdir: string): HookCallbackMatcher {
  const timeoutMs = entry.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  const callback: HookCallback = async (input, _toolUseID, options) => {
    const result = await runHook({
      command: entry.command,
      cwd: workdir,
      input: JSON.stringify(input),
      timeoutMs,
      abortSignal: options.signal,
    });
    if (result.code !== 0) {
      // Non-zero exit: surface as a hook system error. The SDK accepts a free-form
      // object here; deny-ish hooks should use `permissionDecision: 'deny'` in stdout.
      return { systemMessage: `hook '${entry.command}' exited ${result.code}: ${result.stderr.slice(0, 400)}` } as never;
    }
    const out = parseHookOutput(result.stdout);
    return out as never;
  };
  const matcher: HookCallbackMatcher = { hooks: [callback] };
  if (entry.matcher !== undefined) matcher.matcher = entry.matcher;
  if (entry.timeout_ms !== undefined) matcher.timeout = Math.ceil(entry.timeout_ms / 1000);
  return matcher;
}

function parseHookOutput(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (trimmed === "") return {};
  try { return JSON.parse(trimmed); } catch { return {}; }
}

interface RunOpts {
  command: string;
  cwd: string;
  input: string;
  timeoutMs: number;
  abortSignal: AbortSignal;
}
interface RunResult { stdout: string; stderr: string; code: number }

function runHook(opts: RunOpts): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(opts.command, { cwd: opts.cwd, shell: true });
    let stdout = "";
    let stderr = "";
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
    }, opts.timeoutMs);
    const onAbort = () => {
      killed = true;
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
    };
    opts.abortSignal.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (b: Buffer) => { stdout += b.toString(); });
    child.stderr.on("data", (b: Buffer) => { stderr += b.toString(); });
    child.once("error", (err) => {
      clearTimeout(timer);
      opts.abortSignal.removeEventListener("abort", onAbort);
      resolve({ stdout, stderr: stderr || String(err), code: 127 });
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      opts.abortSignal.removeEventListener("abort", onAbort);
      const exit = killed ? 124 : (code ?? 1);
      resolve({ stdout, stderr, code: exit });
    });
    // Swallow EPIPE — process may exit before consuming stdin.
    child.stdin.on("error", () => { /* ignore */ });
    try { child.stdin.write(opts.input); child.stdin.end(); } catch { /* ignore */ }
  });
}

async function readFileSafe(path: string): Promise<string | null> {
  try { return await readFile(path, "utf8"); } catch { return null; }
}
