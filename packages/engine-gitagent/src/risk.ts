/**
 * Risk classifier for permission requests (Wedge 1.8).
 *
 * Same heuristic as engine-claude-agent-sdk's risk classifier — duplicated
 * intentionally (no cross-engine package imports). Keep the two files in
 * sync. When divergence emerges (e.g. gitclaw has tool names Claude doesn't),
 * add gitclaw-specific cases below the shared cases.
 *
 * Conservative bias: when in doubt, classify HIGHER. Better to over-prompt
 * than to silently green-light a destructive Bash command.
 */
export function classifyRisk(
  toolName: string,
  input: unknown,
): "low" | "medium" | "high" | "destructive" {
  const t = toolName.toLowerCase();

  if (t === "bash" || t === "shell" || t === "cli") {
    const cmd = (input as { command?: string } | null | undefined)?.command ?? "";
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
    return "high";
  }

  if (t === "write" || t === "edit" || t === "multiedit") return "medium";
  if (t === "delete" || t === "rm") return "high";
  if (t === "webfetch" || t === "websearch") return "medium";
  if (t === "read" || t === "glob" || t === "grep" || t === "ls" || t === "tree") return "low";
  if (t === "skill" || t === "task" || t === "agent" || t === "memory") return "medium";
  if (t.startsWith("mcp__")) return "medium";
  return "medium";
}
