#!/usr/bin/env node
import { defineCommand, runMain } from "citty";
import { runCommand } from "./commands/run.js";
import { healthCommand } from "./commands/health.js";

const main = defineCommand({
  meta: {
    name: "computeragent",
    version: "0.1.0",
    description: "Run any GAP agent, anywhere, with any loop. CLI for the Harness Protocol.",
  },
  subCommands: {
    run: runCommand,
    health: healthCommand,
  },
});

void runMain(main);
