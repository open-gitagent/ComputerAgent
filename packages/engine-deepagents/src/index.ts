/**
 * @computeragent/engine-deepagents — EngineDriver plug-in that wraps
 * LangChain's `deepagents` package (the "batteries-included" agent harness
 * built on LangGraph).
 *
 * Same shape as engine-claude-agent-sdk and engine-gitagent: register at
 * boot via `createHarnessServer({ engines: { deepagents: new DeepAgentsEngine() }})`
 * and clients can call it via `harness: "deepagents"`.
 */
export { DeepAgentsEngine } from "./engine.js";
