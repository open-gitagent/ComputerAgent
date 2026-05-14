# @computeragent/runtime-vzvm

Substrate that boots the ComputerAgent harness inside a Linux VM running on Apple's Virtualization framework, managed via [Tart](https://tart.run/).

Use this when you want:
- Strong isolation (a fresh VM per agent run, torn down on `dispose()`)
- No cloud dependency (everything runs on your Apple Silicon Mac)
- A real Linux kernel inside a Mac (vs. subprocess on Darwin)

Same `Substrate` interface as `runtime-local` and `runtime-e2b` — caller code is identical except for the `runtime` field.

## Prereqs

Apple Silicon Mac, plus:

```bash
brew install cirruslabs/cli/tart
tart pull ghcr.io/cirruslabs/ubuntu:latest   # ~5GB, one-time
```

## Usage

```ts
import { ComputerAgent } from "@computeragent/sdk";
import { VZVMSubstrate } from "@computeragent/runtime-vzvm";

const agent = new ComputerAgent({
  source: { type: "git", url: "github.com/org/my-agent" },
  harness: "claude-agent-sdk",
  envs: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY! },
  runtime: new VZVMSubstrate({
    baseImage: "ghcr.io/cirruslabs/ubuntu:latest",
    sshUser: "admin",
    sshPassword: "admin",
    onLog: (line) => console.error(`[vzvm] ${line}`),
  }),
});

for await (const ev of agent.chat("Write a file named hello.md ...")) {
  // SDK events stream as they arrive
}
await agent.dispose();   // stops + deletes the VM
```

## How it works

On each `bootHarness()`:

1. `tart clone <baseImage> ca-<random>` — ephemeral VM
2. `tart run --no-graphics` (background)
3. Poll `tart ip` until the VM is reachable (~10–30s)
4. SSH in (`node-ssh`, password or key auth)
5. `scp` the prebundled harness (`harness.mjs`, ~1MB ESM) + `package.json`
6. Install Node 20 via NodeSource (one-time per VM, ~30s)
7. `npm install` — pulls `@anthropic-ai/claude-agent-sdk` plus the native ARM Linux binary (~60s)
8. Spawn the harness with `setsid -f` so the SSH channel releases cleanly
9. Poll `http://<vm-ip>:7700/v1/health` until ready

`dispose()` stops + deletes the VM.

## Why `setsid -f`

`ssh.execCommand` waits for the SSH exec channel to close. Standard idioms (`nohup ... &`, `disown`, `( cmd & )`) leave the parent bash holding the channel open even though the spawned node has detached I/O. `setsid -f` forks before calling `setsid(2)` — the parent returns immediately, the child becomes a new session leader fully detached from the channel. This is the only spawn idiom we've found that reliably releases the channel without sudo.

## Live-verified

`examples/wedge3-vzvm-demo.ts` runs the full path end to end against the real Anthropic API: VM boot → bootstrap → harness up → agent writes a file → SDK fetches it back via `/fs/file` → VM torn down.
