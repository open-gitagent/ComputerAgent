// Load .env files BEFORE any other import reads process.env.
//
// Loads in this order (later files override earlier ones):
//   1. monorepo-root .env             (shared with the harness — single source of truth)
//   2. packages/agentos-server/.env   (package-local override, optional)
//
// All paths use `override: false`, so anything already exported in the shell
// wins over both .env files (standard 12-factor behaviour).

import { config } from "dotenv";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// In dev tsx CWD is the package; in the Docker image CWD is the package too.
// Walk up to find the repo root (the dir containing pnpm-workspace.yaml).
function findRepoRoot(start: string): string | null {
  let dir = start;
  for (let i = 0; i < 8; i++) {
    if (existsSync(resolve(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

const here = dirname(fileURLToPath(import.meta.url));   // .../packages/agentos-server/src (or /dist)
const repoRoot = findRepoRoot(here) ?? process.cwd();

// 1. Root .env (preferred — same file the harness uses).
config({ path: resolve(repoRoot, ".env"), override: false });
// 2. Package-local .env, if anyone wants per-package overrides.
config({ path: resolve(here, "..", ".env"), override: false });
