/**
 * GAP tools translator — reads `tools/*.yaml` from a GAP repo, splits them
 * into builtin-aliases (added to Claude SDK's `allowedTools`) and script tools
 * (wrapped in an in-process MCP server via `createSdkMcpServer`).
 *
 * Schema is intentionally lenient (passthrough on unknown fields) so the GAP
 * spec can evolve without us rev-locking. Two implementation kinds are honored
 * today:
 *
 *   implementation:
 *     builtin: Read              # alias to a Claude built-in tool
 *
 *   implementation:
 *     script:
 *       command: bash
 *       args: ["-c", "echo $FOO"]
 *
 * For script tools, the tool's `parameters` (a small JSON Schema subset) is
 * translated to a zod shape so the Claude SDK can validate inputs; argument
 * values are exposed to the script as UPPERCASE environment variables plus a
 * single JSON object on stdin.
 */
import { readFile, readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z, type ZodRawShape, type ZodTypeAny } from "zod";
import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";

const GapTool = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    parameters: z
      .object({
        type: z.literal("object").optional(),
        properties: z.record(z.string(), z.any()).optional(),
        required: z.array(z.string()).optional(),
      })
      .passthrough()
      .optional(),
    implementation: z
      .object({
        builtin: z.string().optional(),
        script: z
          .object({
            command: z.string(),
            args: z.array(z.string()).optional(),
            cwd: z.string().optional(),
            env: z.record(z.string(), z.string()).optional(),
            timeout_ms: z.number().int().positive().optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough(),
  })
  .passthrough();
type GapTool = z.infer<typeof GapTool>;

export interface ToolsLoadResult {
  /** Built-in tool aliases to expose via Claude SDK's `allowedTools`. */
  readonly allowedTools: string[];
  /** Optional in-process MCP server packaging every script tool. */
  readonly mcpServer: McpSdkServerConfigWithInstance | undefined;
  /** Fully-qualified MCP tool names ready to add to `allowedTools`. */
  readonly mcpToolNames: string[];
}

const MCP_SERVER_NAME = "gap_tools";

export async function loadGapTools(workdir: string): Promise<ToolsLoadResult> {
  const yamlFiles = await listToolFiles(workdir);
  const tools: GapTool[] = [];
  for (const path of yamlFiles) {
    try {
      const raw = await readFile(path, "utf8");
      let yaml: unknown;
      try { yaml = parseYaml(raw); } catch { continue; }
      const parsed = GapTool.safeParse(yaml);
      if (parsed.success) tools.push(parsed.data);
      // Tools that fail validation are silently skipped — surfacing the error
      // would couple this translator to a logging API. Validators can be
      // added as a separate concern.
    } catch {
      // Unreadable file; skip.
    }
  }

  const allowedTools: string[] = [];
  const scriptTools: GapTool[] = [];
  for (const t of tools) {
    if (t.implementation.builtin) {
      allowedTools.push(t.implementation.builtin);
    } else if (t.implementation.script) {
      scriptTools.push(t);
    }
  }

  if (scriptTools.length === 0) {
    return { allowedTools, mcpServer: undefined, mcpToolNames: [] };
  }

  const sdkTools = scriptTools.map((t) => buildScriptTool(t, workdir));
  const mcpServer = createSdkMcpServer({
    name: MCP_SERVER_NAME,
    version: "0.1.0",
    tools: sdkTools,
  });
  const mcpToolNames = scriptTools.map((t) => `mcp__${MCP_SERVER_NAME}__${t.name}`);

  return { allowedTools, mcpServer, mcpToolNames };
}

async function listToolFiles(workdir: string): Promise<string[]> {
  const dir = join(workdir, "tools");
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith(".yaml") || n.endsWith(".yml"))
    .map((n) => join(dir, n));
}

function buildScriptTool(t: GapTool, workdir: string): ReturnType<typeof tool> {
  const shape = jsonSchemaToZodShape(t.parameters);
  const script = t.implementation.script!;
  const handler = async (args: Record<string, unknown>) => {
    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      ...(script.env ?? {}),
    };
    for (const [k, v] of Object.entries(args)) {
      env[k.toUpperCase()] = stringify(v);
    }
    const { stdout, stderr, code } = await runProcess({
      command: script.command,
      args: script.args ?? [],
      cwd: script.cwd ? join(workdir, script.cwd) : workdir,
      env,
      timeoutMs: script.timeout_ms ?? 30_000,
      stdin: JSON.stringify(args),
    });
    if (code !== 0) {
      return {
        content: [{ type: "text" as const, text: `exit ${code}: ${stderr.slice(0, 800)}` }],
        isError: true,
      };
    }
    return { content: [{ type: "text" as const, text: stdout }] };
  };
  return tool(t.name, t.description ?? `GAP tool: ${t.name}`, shape, handler);
}

interface RunOpts {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  stdin: string;
}
interface RunResult { stdout: string; stderr: string; code: number }

function runProcess(opts: RunOpts): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(opts.command, opts.args, { cwd: opts.cwd, env: opts.env });
    let stdout = "";
    let stderr = "";
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
    }, opts.timeoutMs);
    child.stdout.on("data", (b: Buffer) => { stdout += b.toString(); });
    child.stderr.on("data", (b: Buffer) => { stderr += b.toString(); });
    child.once("error", (err) => {
      clearTimeout(timer);
      resolve({ stdout, stderr: stderr || String(err), code: 127 });
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      const exit = killed ? 124 : (code ?? 1);
      resolve({ stdout, stderr, code: exit });
    });
    // Swallow EPIPE (process exited before stdin was consumed) — async stream errors
    // bypass the try/catch around .write(); without this listener Node reports an
    // unhandled error.
    child.stdin.on("error", () => { /* ignore */ });
    try { child.stdin.write(opts.stdin); child.stdin.end(); } catch { /* ignore */ }
  });
}

function jsonSchemaToZodShape(parameters: GapTool["parameters"]): ZodRawShape {
  if (!parameters?.properties) return {};
  const required = new Set(parameters.required ?? []);
  const shape: Record<string, ZodTypeAny> = {};
  for (const [name, raw] of Object.entries(parameters.properties)) {
    const prop = raw as { type?: string; description?: string };
    let z_: ZodTypeAny;
    switch (prop.type) {
      case "string": z_ = z.string(); break;
      case "number": z_ = z.number(); break;
      case "integer": z_ = z.number().int(); break;
      case "boolean": z_ = z.boolean(); break;
      case "array": z_ = z.array(z.any()); break;
      case "object": z_ = z.record(z.string(), z.any()); break;
      default: z_ = z.any(); break;
    }
    if (prop.description) z_ = z_.describe(prop.description);
    shape[name] = required.has(name) ? z_ : z_.optional();
  }
  return shape as unknown as ZodRawShape;
}

function stringify(v: unknown): string {
  if (typeof v === "string") return v;
  if (v === null || v === undefined) return "";
  return JSON.stringify(v);
}
