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
  /**
   * Anthropic API key used to translate natural-language modify feedback
   * ("rename to gello.txt") into a structured input change. Defaults to
   * `process.env.ANTHROPIC_API_KEY`. If unset AND the user picks modify,
   * we fall back to raw-JSON entry with a clear note.
   */
  readonly anthropicApiKey?: string;
  /** Model used for the modify translation. Default: claude-haiku-4-5. */
  readonly modifyModel?: string;
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
  const apiKey = opts.anthropicApiKey ?? process.env.ANTHROPIC_API_KEY;
  const modifyModel = opts.modifyModel ?? "claude-haiku-4-5-20251001";

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
        const updated = await collectModifications(
          call.toolName,
          call.input,
          stdin,
          stdout,
          apiKey,
          modifyModel,
        );
        if (updated === null) {
          stdout.write("  Cancelled — re-deciding.\n");
          stdout.write(`  [a]llow / [d]eny / [m]odify  > `);
          continue;
        }
        stdout.write(dim(`  [hil] modified — sending updated input\n`));
        return { decision: "modify", input: updated };
      }
      stdout.write(`  ✗ unknown choice "${choice}". Use a / d / m.\n  > `);
    }
  };
}

/**
 * Natural-language modify flow.
 *
 * Shows the user the current input. Asks for plain-English feedback (e.g.
 * "rename to gello.txt", "use a longer description"). Calls Claude Haiku
 * with the current input + feedback and asks for a strict JSON-object diff
 * representing the new input. Validates, shows the user the result, and
 * returns it.
 *
 * Falls back to raw-JSON entry if no API key is available — with a clear
 * one-line note so the user knows why.
 *
 * Returns the new input object, OR `null` if the user typed `cancel` or
 * the translation failed irrecoverably.
 */
async function collectModifications(
  toolName: string,
  currentInput: unknown,
  stdin: NodeJS.ReadableStream,
  stdout: NodeJS.WritableStream,
  apiKey: string | undefined,
  model: string,
): Promise<Record<string, unknown> | null> {
  const current = (typeof currentInput === "object" && currentInput !== null && !Array.isArray(currentInput))
    ? (currentInput as Record<string, unknown>)
    : {};

  stdout.write("  Current input:\n");
  for (const line of JSON.stringify(current, null, 2).split("\n")) {
    stdout.write(`    ${line}\n`);
  }

  if (!apiKey) {
    stdout.write(
      "  ⚠ No ANTHROPIC_API_KEY in env — natural-language modify unavailable.\n" +
        "  Paste a JSON object to replace the input, or type `cancel`.\n" +
        "  > ",
    );
    const raw = (await readLine(stdin)).trim();
    if (raw.toLowerCase() === "cancel") return null;
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("must be a JSON object");
      }
      return parsed;
    } catch (e) {
      stdout.write(`  ✗ JSON parse error: ${(e as Error).message}. Cancelling.\n`);
      return null;
    }
  }

  stdout.write(
    "  Describe the change in plain English. Examples:\n" +
      `    rename the file to gello.txt\n` +
      `    make the content say hello world\n` +
      `    add a comment at the top\n` +
      "  Type `cancel` to abort.\n",
  );

  while (true) {
    stdout.write("  feedback > ");
    const feedback = (await readLine(stdin)).trim();
    if (!feedback) {
      stdout.write("  ✗ empty feedback — type something or `cancel`.\n");
      continue;
    }
    if (feedback.toLowerCase() === "cancel") return null;

    stdout.write(dim(`  [hil] translating via ${model}…\n`));
    const updated = await translateModify(apiKey, model, toolName, current, feedback);
    if (!updated) {
      stdout.write("  ✗ translation failed or produced invalid JSON. Try again, or `cancel`.\n");
      continue;
    }

    stdout.write("  Updated input:\n");
    for (const out of JSON.stringify(updated, null, 2).split("\n")) {
      stdout.write(`    ${out}\n`);
    }
    stdout.write("  Apply this? [y]es / [n]o (rewrite feedback) / [c]ancel  > ");
    const conf = (await readLine(stdin)).trim().toLowerCase();
    if (conf === "" || conf === "y" || conf === "yes") return updated;
    if (conf === "c" || conf === "cancel") return null;
    // Anything else → loop and ask for new feedback.
    stdout.write("  Rewriting — give a different feedback below.\n");
  }
}

/**
 * Calls Claude Haiku 4.5 with the current tool input + the user's natural-language
 * feedback, asks for a strict JSON-object response representing the modified
 * input. Returns the parsed object or null on any failure.
 *
 * Uses the bare Anthropic Messages API (no SDK dep) to keep this file self-contained.
 */
async function translateModify(
  apiKey: string,
  model: string,
  toolName: string,
  currentInput: Record<string, unknown>,
  feedback: string,
): Promise<Record<string, unknown> | null> {
  const system = (
    "You translate a human's plain-English feedback about a tool call into a " +
    "modified version of the tool's input JSON. Output ONLY the new JSON object " +
    "— no prose, no markdown, no code fences. Preserve all existing fields the " +
    "human didn't ask to change. Keep the same keys and value types unless the " +
    "feedback explicitly asks for a structural change."
  );
  const user = (
    `Tool: ${toolName}\n` +
    `Current input:\n${JSON.stringify(currentInput, null, 2)}\n\n` +
    `Human feedback: ${feedback}\n\n` +
    `Return ONLY the new input as a JSON object. No explanation. No markdown.`
  );

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        system,
        messages: [{ role: "user", content: user }],
      }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      content?: Array<{ type?: string; text?: string }>;
    };
    const text = (body.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
    // Strip code fences if the model insists on them
    const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
    const parsed = JSON.parse(cleaned) as Record<string, unknown>;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
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
