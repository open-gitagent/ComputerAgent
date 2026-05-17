/**
 * Human-in-the-Loop helpers (Wedge 1.8).
 *
 * The Claude Agent SDK and gitclaw already do the engine-side plumbing for
 * permission gating. This file ships ergonomic `onToolCall` callbacks for the
 * common cases — TTY prompt is the only one shipped today; webhook variants
 * will land separately when there's a real consumer.
 */
import type { PermissionDecision, ToolCallContext } from "./types.js";

type RiskLevel = "low" | "medium" | "high" | "destructive";

const RISK_ORDER: Record<RiskLevel, number> = {
  low: 0,
  medium: 1,
  high: 2,
  destructive: 3,
};

interface TTYApprovalOptions {
  /**
   * Auto-allow when the tool's risk is STRICTLY BELOW this level. Default:
   * "destructive" means everything except destructive prompts (which always
   * prompt unless `riskGate: "none"`). To prompt for everything use "low".
   * To auto-allow up to and including high use "destructive".
   */
  readonly riskGate?: RiskLevel | "none";
  /**
   * What to do when the user just hits Enter without typing. Default: "deny"
   * (safe default — if you're not paying attention, don't approve).
   */
  readonly defaultDecision?: "allow" | "deny";
  /** Override stdin (for testing). Defaults to process.stdin. */
  readonly stdin?: NodeJS.ReadableStream & { setRawMode?: (m: boolean) => void };
  /** Override stdout (for testing). Defaults to process.stdout. */
  readonly stdout?: NodeJS.WritableStream;
}

/**
 * Returns an `onToolCall` callback that prompts the user at the terminal.
 *
 *   import { ComputerAgent, ttyApproval } from "computeragent";
 *
 *   const agent = new ComputerAgent({
 *     ...
 *     options: { permissionMode: "default" },     // NOT bypassPermissions
 *     onToolCall: ttyApproval({ riskGate: "high" }),
 *   });
 *
 * Behavior:
 *   - When `call.risk` < `riskGate` → auto-allow, log one dim line.
 *   - Else → print a 5-line block (TOOL / RISK / INPUT / hotkey prompt)
 *     and read one line from stdin. `a`/`A`/Enter (if default=allow) →
 *     allow. `d`/`D`/Enter (if default=deny) → deny. `m`/`M` → modify;
 *     re-prompt for a JSON object, validated, then re-prompt on parse error.
 *
 * For non-TTY environments (CI, scripts), prefer a webhook callback or roll
 * a custom `onToolCall` directly. This helper assumes a real terminal.
 */
export function ttyApproval(opts: TTYApprovalOptions = {}): (call: ToolCallContext) => Promise<PermissionDecision> {
  const riskGate = opts.riskGate ?? "destructive";
  const defaultDecision = opts.defaultDecision ?? "deny";
  const stdin = opts.stdin ?? process.stdin;
  const stdout = opts.stdout ?? process.stdout;

  return async (call) => {
    // Auto-allow when below the gate. "none" means always prompt.
    if (riskGate !== "none" && call.risk !== undefined) {
      if (RISK_ORDER[call.risk] < RISK_ORDER[riskGate]) {
        stdout.write(
          dim(`  [hil] auto-allow ${call.toolName} (risk=${call.risk}, below gate=${riskGate})\n`),
        );
        return { decision: "allow" };
      }
    }

    const banner = renderPrompt(call, defaultDecision);
    stdout.write(banner);

    while (true) {
      const line = (await readLine(stdin)).trim().toLowerCase();
      const choice = line || (defaultDecision === "allow" ? "a" : "d");
      if (choice === "a" || choice === "allow") {
        stdout.write(dim(`  [hil] allowed\n`));
        return { decision: "allow" };
      }
      if (choice === "d" || choice === "deny") {
        stdout.write(dim(`  [hil] denied\n`));
        return { decision: "deny", reason: "denied at TTY" };
      }
      if (choice === "m" || choice === "modify") {
        stdout.write("  New input (JSON): ");
        const raw = (await readLine(stdin)).trim();
        try {
          const parsed = JSON.parse(raw) as Record<string, unknown>;
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            throw new Error("input must be a JSON object");
          }
          stdout.write(dim(`  [hil] modified — sending updated input\n`));
          return { decision: "modify", input: parsed };
        } catch (e) {
          stdout.write(`  ✗ parse error: ${(e as Error).message}. Try again.\n  `);
          continue;
        }
      }
      stdout.write(`  ✗ unknown choice "${choice}". Use a / d / m. \n  `);
    }
  };
}

function renderPrompt(call: ToolCallContext, defaultDecision: "allow" | "deny"): string {
  const inputJson = safeStringify(call.input, 400);
  const risk = call.risk ?? "?";
  const riskBadge = colorRisk(risk);
  return (
    "\n" +
    "  ┌─ Permission request ───────────────────────────────────────────────\n" +
    `  │ TOOL:  ${call.toolName}\n` +
    `  │ RISK:  ${riskBadge}\n` +
    `  │ INPUT: ${inputJson}\n` +
    "  └─────────────────────────────────────────────────────────────────────\n" +
    `  [a]llow / [d]eny / [m]odify  (default: ${defaultDecision === "allow" ? "allow" : "deny"})  > `
  );
}

function safeStringify(value: unknown, maxLen: number): string {
  let s: string;
  try {
    s = JSON.stringify(value);
  } catch {
    s = String(value);
  }
  if (s === undefined) s = "undefined";
  return s.length > maxLen ? s.slice(0, maxLen - 1) + "…" : s;
}

function colorRisk(risk: string): string {
  if (!process.stdout.isTTY) return risk;
  const map: Record<string, string> = {
    low: "\x1b[32mlow\x1b[0m",                // green
    medium: "\x1b[33mmedium\x1b[0m",          // yellow
    high: "\x1b[91mhigh\x1b[0m",              // bright red
    destructive: "\x1b[1;41m destructive \x1b[0m",  // bold-on-red bg
  };
  return map[risk] ?? risk;
}

function dim(s: string): string {
  return process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s;
}

/**
 * Read one line from a stream. Resolves on \n. Strips \r if present.
 * Doesn't use Node's readline because we want to compose this in a callback
 * that might fire concurrently — readline holds a global on the stream.
 */
function readLine(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve) => {
    let buf = "";
    const onData = (chunk: Buffer | string): void => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      buf += text;
      const nl = buf.indexOf("\n");
      if (nl !== -1) {
        const line = buf.slice(0, nl).replace(/\r$/, "");
        stream.off("data", onData);
        resolve(line);
      }
    };
    stream.on("data", onData);
  });
}
