/**
 * Human-in-the-Loop interactive demo (Wedge 1.8).
 *
 * Run this. The agent will pause and ASK YOU before running any tool. Type
 * `a` to allow, `d` to deny, `m` to modify the tool's input. Low-risk
 * read-only tools auto-allow with a dim log line.
 *
 *   ANTHROPIC_API_KEY=sk-ant-... bun run examples/hil-demo.ts
 *
 * What you're proving:
 *   - The protocol's `ca_permission_request` round-trip is real and blocks
 *     the agent on a human decision.
 *   - Risk classification works (Bash/Write = medium/high/destructive;
 *     Read/Glob = low).
 *   - The `modify` decision actually rewrites the tool's input.
 *   - GAP compliance (`human_in_the_loop: always`) is enforced — the
 *     inline agent declares it, and your `bypassPermissions` would be
 *     overridden by harden().
 */
import { ComputerAgent, LocalSubstrate, ttyApproval } from "computeragent";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) throw new Error("Set ANTHROPIC_API_KEY first.");

await using agent = new ComputerAgent({
  source: {
    type: "inline",
    manifest: { name: "hil-demo", version: "0.1.0" },
    files: {
      "agent.yaml": [
        'spec_version: "0.1.0"',
        "name: hil-demo",
        "version: 0.1.0",
        "model:",
        "  preferred: claude-haiku-4-5-20251001",
        // The CRITICAL line: declares that every tool call needs human review.
        // The loader's harden() reads this and overrides any caller's
        // `permissionMode: bypassPermissions` to "default" — the GAP contract
        // wins (strictest-wins per PLAN.md).
        "compliance:",
        "  supervision:",
        "    human_in_the_loop: always",
      ].join("\n"),
      "SOUL.md":
        "You help the user with file system tasks. Use the Read, Write, " +
        "Bash, and Glob tools. Keep responses short.",
    },
  },
  harness: "claude-agent-sdk",
  runtime: new LocalSubstrate(),
  envs: { ANTHROPIC_API_KEY },
  // Even though we set bypassPermissions, the GAP repo's compliance
  // directive will override it via harden(). Watch — prompts will still fire.
  options: { permissionMode: "bypassPermissions" },
  // The TTY approval helper. Auto-allow low-risk; prompt for everything else.
  onToolCall: ttyApproval({ riskGate: "medium", defaultDecision: "deny" }),
});

console.log(
  "\nHIL demo starting. The agent will:\n" +
    "  1. Ask you to approve each tool call (low-risk ones auto-allow).\n" +
    "  2. Pause until you type a/d/m + Enter.\n" +
    "  3. If you type 'm', supply a JSON object as the new input.\n",
);

const result = await agent.chat(
  "List the files in the current directory, then create a file " +
    "called hello.txt containing the word 'demo'. Use the Bash tool for ls.",
);

const text = result.messages
  .map((m) => m as { type?: string; result?: string })
  .filter((m) => m.type === "result")
  .map((m) => m.result)
  .join("");

console.log(`\n${"─".repeat(70)}`);
console.log(`Agent done. Total: ${result.usage.inputTokens + result.usage.outputTokens} tokens • $${result.usage.costUsd?.toFixed(4) ?? "?"}`);
console.log(`\nFinal answer: ${text}`);
