/**
 * Risk classifier for permission requests (Wedge 1.8).
 *
 * Cheap heuristics based on the tool name + a quick look at the args. Lets
 * HIL callbacks (`onToolCall` on the SDK) gate by severity and lets users
 * write `ttyApproval({ riskGate: "high" })` to auto-allow safe operations.
 *
 * Conservative bias: when in doubt, classify HIGHER. Better to over-prompt
 * than to silently green-light a destructive Bash command.
 *
 * Tool names follow Claude Agent SDK's canonical set (Bash, Write, Edit,
 * Read, Grep, Glob, WebFetch, WebSearch, …). Custom MCP tools default to
 * "medium" — they could do anything.
 */
export function classifyRisk(
  toolName: string,
  input: unknown,
): "low" | "medium" | "high" | "destructive" {
  const t = toolName.toLowerCase();

  // Bash / shell — scan for the most-destructive patterns first.
  if (t === "bash" || t === "shell") {
    const cmd = (input as { command?: string } | null | undefined)?.command ?? "";
    // Destructive: file system wipes, format, DB drops, raw disk writes
    if (
      /\brm\s+-r[fF]?[a-z]*\s+[/~]/i.test(cmd) ||
      /\brm\s+-rf?\b\s+\*/i.test(cmd) ||
      /\bsudo\s+rm\s+-r[fF]?/i.test(cmd) ||
      /\bdrop\s+(table|database|schema)\b/i.test(cmd) ||
      /\bmkfs\b/i.test(cmd) ||
      /\bdd\s+if=.*of=\/dev\//i.test(cmd) ||
      /\bshutdown\b|\breboot\b|\bhalt\b/i.test(cmd) ||
      />\s*\/dev\/(sd[a-z]|nvme|disk)/i.test(cmd)
    ) {
      return "destructive";
    }
    // Otherwise Bash is high by default — even "ls" could be repurposed.
    return "high";
  }

  // File writes / edits — can damage state but scoped to the workdir.
  if (t === "write" || t === "edit" || t === "multiedit") return "medium";
  if (t === "delete" || t === "rm") return "high";

  // Network access — read-only but leaks data + can fetch malicious content.
  if (t === "webfetch" || t === "websearch") return "medium";

  // Read-only file operations.
  if (t === "read" || t === "glob" || t === "grep" || t === "ls" || t === "tree") return "low";

  // Skill / sub-agent invocations — opaque, default to medium.
  if (t === "skill" || t === "task" || t === "agent") return "medium";

  // Tool name starts with `mcp__` — third-party MCP tool, unknown capabilities.
  if (t.startsWith("mcp__")) return "medium";

  // Default for unknown built-ins: medium (don't auto-allow blindly).
  return "medium";
}
