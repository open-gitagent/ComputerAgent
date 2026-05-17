# @computeragent/runtime-bwrap

Bubblewrap-based Substrate for the ComputerAgent harness. Runs each agent's
harness child inside a `bwrap` sandbox: mount + PID + IPC + UTS + user
namespaces, filesystem jailed to a per-session workdir, all Linux capabilities
dropped.

Drop-in for `LocalSubstrate`:

```ts
import { ComputerAgentServer } from "./computeragent-server.ts";
import { BwrapSubstrate } from "@computeragent/runtime-bwrap";

const server = new ComputerAgentServer({
  port: 8787,
  substrate: () => new BwrapSubstrate({
    extraRoBinds: [
      // See "Deploy on Linux" below — one-time staging of the harness's
      // node-resolved externals.
      { src: "/var/lib/computeragent/runtime/node_modules", dest: "/harness/node_modules" },
    ],
  }),
});
```

Linux only. On macOS/Windows the substrate fails fast with a clear
"use LocalSubstrate" message.

---

## What you get

Inside the sandbox the agent sees:

| Probe | Result |
|---|---|
| `ls /` | only `bin/ dev/ etc/ harness/ lib/ lib64/ opt/ proc/ sbin/ sys/ tmp/ usr/ var/ workdir/` — host filesystem invisible |
| `cat ~/.ssh/id_rsa` | `No such file or directory` — `HOME=/workdir`, host home not bound |
| `cat /etc/passwd` | readable (intentional, libuv needs `uv_os_homedir`); `/etc/shadow` (password hashes) NOT bound |
| `id` | `uid=<host-uid>(<username>)`, host's secondary groups collapsed to `nogroup` |
| `ps -ef` | only the agent's own processes (separate PID namespace) |
| outbound HTTPS | works (`--share-net` for Anthropic API) — disable with `shareNetwork: false` for hermetic runs |
| write outside `/workdir` | `EROFS` — only the per-session workdir + `/tmp` (private tmpfs) are writable |

---

## Deploy on Linux

### One-time host setup

```bash
# Debian/Ubuntu
sudo apt-get update
sudo apt-get install -y \
  bubblewrap                  `# the sandbox itself` \
  unzip curl ca-certificates  `# build/install prereqs` \
  poppler-utils               `# PDF rendering — Claude Code's Read tool shells out to pdftoppm` \
  git                         `# for git-source GAP repos`

# Node 22 (NodeSource)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# pnpm + bun (bun is needed for `pnpm -r build` to bundle the harness)
sudo npm install -g pnpm@9.4.0
curl -fsSL https://bun.sh/install | bash
echo 'export PATH="$HOME/.bun/bin:$PATH"' >> ~/.bashrc

# Verify
bwrap --version       # >= 0.11
node --version        # >= 22
pnpm --version        # 9.x
~/.bun/bin/bun --version
pdftoppm -v 2>&1 | head -1   # >= 23.x (any recent poppler is fine)
```

### Why poppler-utils?

The `claude-agent-sdk` engine spawns the Claude Code CLI binary inside the
bwrap sandbox. Claude Code's `Read` tool, when given a `.pdf` file path,
calls `pdftoppm` from `poppler-utils` to rasterize each page to a PNG, then
ships those PNGs to the Anthropic API as image content blocks. **Without
`pdftoppm` on PATH, every PDF read fails with "pdftoppm is not installed".**

Because we bind `/usr` read-only into every sandbox (see `bwrap-args.ts`),
installing `poppler-utils` once on the host makes it visible to every
current and future bwrap session — no per-session staging needed.

The same applies to any other host-side CLI tool an agent might need at
runtime (`unzip`, `jq`, `ffmpeg`, `sqlite3`, etc.). Install on the host,
they show up in `/usr/bin` inside the sandbox automatically.

### Get the code

The simplest path is a tarball of committed files (no node_modules, no
working-tree state):

```bash
# On your dev box:
git archive HEAD --format=tar.gz -o /tmp/computeragent-snapshot.tgz
scp /tmp/computeragent-snapshot.tgz user@host:/tmp/

# On the host:
mkdir -p ~/ComputerAgent
tar -xzf /tmp/computeragent-snapshot.tgz -C ~/ComputerAgent
cd ~/ComputerAgent
export PATH="$HOME/.bun/bin:$PATH"
pnpm install
pnpm -r build
```

Alternative: `git clone https://github.com/open-gitagent/ComputerAgent`.

### Stage the harness externals (one time per host)

The runtime-local harness bundle (which `BwrapSubstrate` reuses) externalizes
two packages so they can resolve at runtime:

- `@anthropic-ai/claude-agent-sdk` (ships a native CLI binary)
- `gitclaw`

They live outside the bundle in a flat `node_modules` directory. Stage them
once on the host so every sandbox can bind-mount the same tree read-only:

```bash
sudo mkdir -p /var/lib/computeragent/runtime
sudo chown $USER /var/lib/computeragent/runtime
cp ~/ComputerAgent/packages/runtime-e2b/assets/sandbox-package.json \
   /var/lib/computeragent/runtime/package.json
cd /var/lib/computeragent/runtime
npm install --include=optional --no-fund --no-audit
# Verify
ls node_modules/@anthropic-ai/
# Should show: claude-agent-sdk, claude-agent-sdk-linux-x64
```

(`/tmp` works too, but `/tmp` is wiped on reboot — `/var/lib` survives.)

### Wire the bind path into your server

`examples/server-bwrap-demo.ts` shows the shape — adjust the `extraRoBinds`
path:

```ts
substrate: () => new BwrapSubstrate({
  extraRoBinds: [
    { src: "/var/lib/computeragent/runtime/node_modules",
      dest: "/harness/node_modules" },
  ],
}),
```

### Run

```bash
cd ~/ComputerAgent/examples
ANTHROPIC_API_KEY=sk-ant-...  \
  node --experimental-strip-types --no-warnings server-bwrap-demo.ts
```

The demo runs an isolation probe — you should see the agent reporting an
empty home directory and a sandboxed `/`. Replace the demo with your own
ComputerAgentServer + endpoints when ready.

---

## Verify isolation

Want to prove the jail is real? Run this prompt against a fresh agent (or
just use `examples/server-bwrap-demo.ts`):

```
Run each via the Bash tool, report raw output:
  /usr/bin/ls /
  /usr/bin/cat $HOME/.ssh/id_rsa 2>&1
  /usr/bin/id
```

Expected output inside the sandbox:

```
ls /              → bin dev etc harness home lib lib64 opt proc sbin sys tmp usr var workdir
~/.ssh/id_rsa     → No such file or directory
id                → uid=<host uid>(<user>) gid=<host gid>(<user>) groups=...,nogroup,...
```

Run the same prompt against `LocalSubstrate` for comparison — you'll see the
real host filesystem and any SSH keys the user has access to.

---

## Production considerations

This package gives you **namespace isolation** out of the box. The following
are deliberate gaps you should address before exposing the server publicly:

| Concern | Where to fix |
|---|---|
| **No auth on the HTTP server** | Caddy/Nginx with bearer-token auth in front of `ComputerAgentServer` |
| **CPU / RAM caps** | Wrap the bwrap process in `systemd-run --scope --property=MemoryMax=2G --property=CPUQuota=200%`. Set via `bwrapPath: "systemd-run --..."` is not supported today — fork the substrate or upstream a PR. |
| **Network egress** | Agents can reach the open internet. Add `nftables` rules per-namespace, or run with `shareNetwork: false` and proxy specific outbound calls through the parent. |
| **Process budget** | `ComputerAgentServer.maxConcurrentRuns` caps concurrent agents (default 4). Each bwrap+node child takes ~250MB RAM. |
| **Disk quota for /workdir** | `/workdir` is a bind-mount of a real host directory. Set up a per-user disk quota on the parent path, or rotate session workdirs aggressively. |

---

## Architectural notes

### Why not Docker?

Docker requires a daemon, root group membership, image management, registry
auth, an entire networking layer. Bubblewrap is ~1.5MB, no daemon, no
configuration — just a binary that wraps a command in Linux namespaces.
Same isolation primitives (`unshare`, `pivot_root`, capability drops); fewer
moving parts.

### Why not gVisor / Firecracker?

Stronger isolation, much heavier. gVisor adds a userspace kernel; Firecracker
is a hypervisor. For workloads where you trust the agents not to be hostile
nation-state actors, namespace isolation is the right cost/security trade.

### What's NOT in scope here

- **Auth/AuthZ** — `ComputerAgentServer` is stateless about identity; add
  middleware (or front it with Caddy) for production
- **Multi-tenancy** — no per-tenant quotas, billing, or session isolation
  beyond what the substrate provides
- **CPU/memory cgroups** — see "Production considerations"
- **Image-based sandboxes** — bwrap binds host paths read-only; you don't
  get a frozen image to roll back to

---

## Live-tested deployment

This package was verified on Ubuntu 26.04 LTS (kernel 7.0) in commit
`15c6468`:

- ✓ bubblewrap 0.11.1 + node 22.22.2 + pnpm 9.4.0 + bun 1.3.14
- ✓ Full `pnpm -r build` clean (19 packages)
- ✓ `bwrap-args.test.ts` 10/10 passing
- ✓ `examples/server-bwrap-demo.ts` end-to-end: ComputerAgentServer boots,
  POST /run accepted, BwrapSubstrate spawns, harness child runs, Claude
  Agent SDK launches, agent completes 5 tool calls, session ends cleanly,
  substrate disposes
- ✓ Isolation probe confirmed: agent sees only `bin/lib/usr/workdir/...`,
  host's `~/.ssh/id_rsa` returns `No such file or directory`

---

## License

MIT.
