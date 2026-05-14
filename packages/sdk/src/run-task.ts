import { ComputerAgent } from "./computer-agent.js";
import type { ChatInput, ChatResult, ComputerAgentOptions } from "./types.js";

/** Options for the one-shot `runTask` helper. */
export interface RunTaskOptions extends ComputerAgentOptions {
  /** The task to perform — same shapes accepted by `agent.chat()`. */
  readonly message: ChatInput;
}

/**
 * One-shot convenience: provide a task, the agent does it, the substrate
 * (if any) is torn down before we return. Equivalent to:
 *
 *   const agent = new ComputerAgent(opts);
 *   try { return await agent.chat(message); }
 *   finally { await agent.dispose(); }
 *
 * Use this when you don't need to inspect mid-flight events or push
 * follow-up messages — i.e. most automation scripts and CLI tools.
 * For interactive sessions, construct the agent directly and call
 * `.chat()` repeatedly.
 */
export async function runTask(opts: RunTaskOptions): Promise<ChatResult> {
  const { message, ...agentOpts } = opts;
  const agent = new ComputerAgent(agentOpts);
  try {
    return await agent.chat(message);
  } finally {
    await agent.dispose();
  }
}
