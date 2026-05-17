/**
 * `@computeragent/runtime-bwrap` — Bubblewrap-based Substrate.
 *
 * Linux-only. Runs the harness server inside a `bwrap` sandbox so each agent
 * gets its own mount + PID + IPC + UTS + user namespace, filesystem jailing
 * to a per-session workdir, and the empty Linux capability set.
 *
 * Same Substrate interface as @computeragent/runtime-local — drop-in swap:
 *
 *   new ComputerAgent({
 *     ...,
 *     runtime: new BwrapSubstrate(),    // was: new LocalSubstrate()
 *   });
 */
export { BwrapSubstrate } from "./bwrap-substrate.js";
export type { BwrapSubstrateOptions } from "./bwrap-substrate.js";
export { buildBwrapArgs } from "./bwrap-args.js";
export type { BwrapArgsOptions } from "./bwrap-args.js";
