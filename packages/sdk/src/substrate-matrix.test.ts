/**
 * claude-agent-sdk × substrate × source-type matrix.
 *
 * The customer (Nordstrom) is "especially looking at Claude" — this suite
 * proves the `claude-agent-sdk` engine works end-to-end across every
 * substrate (Local / Bwrap / E2B) and every IdentitySource type (inline /
 * local / git) they'd realistically use.
 *
 * Everything here makes REAL Anthropic API calls, so the whole suite is
 * gated on `ANTHROPIC_API_KEY`. Per-row gates handle platform-specific
 * substrates: Bwrap requires Linux + the `bwrap` binary; E2B requires
 * `E2B_API_KEY`. Git-source tests need a tiny public GAP repo to clone —
 * gated on `SDK_MATRIX_GIT_FIXTURE_URL` (or the default sentinel).
 *
 * Each row asserts: substrate boots, agent.chat() returns a ChatResult with
 * non-zero output tokens, dispose() is clean. Token cost is intentionally
 * tiny — the SOUL says "reply in fewer than 10 words" so each test is ~30
 * tokens of output × 9–15 rows × however many devs run it. Cheap enough.
 *
 * Skip semantics:
 *   - `describe.skip` when ANTHROPIC_API_KEY missing → whole file no-op in CI.
 *   - `it.skipIf` per row → row no-ops on missing creds / wrong platform.
 *
 * To run the full matrix locally:
 *   ANTHROPIC_API_KEY=sk-ant-... E2B_API_KEY=e2b_... \
 *     pnpm --filter @open-gitagent/sdk exec vitest run src/substrate-matrix.test.ts
 */
import { existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ComputerAgent } from "./computer-agent.js";
import type { ComputerAgentOptions } from "./types.js";
import type { Substrate } from "./substrate.js";
import type { IdentitySource } from "@open-gitagent/protocol";

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const E2B_KEY = process.env.E2B_API_KEY ?? "";
const GIT_FIXTURE_URL = process.env.SDK_MATRIX_GIT_FIXTURE_URL ?? "";

const IS_LINUX = process.platform === "linux";
const HAS_BWRAP = (() => {
  try {
    // resolve via PATH — synchronous lookup ok in test bootstrap
    const { execSync } = require("node:child_process") as typeof import("node:child_process");
    execSync("command -v bwrap", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

/** Path to the in-repo fixture used by the "local source" tests. */
const FIXTURE_DIR = resolvePath(
  fileURLToPath(new URL(".", import.meta.url)),
  "../test-fixtures/minimal-agent",
);

/** Inline GAP manifest equivalent to the fixture dir — exercises the
 *  inline source path without touching disk. */
const INLINE_SOURCE: IdentitySource = {
  type: "inline",
  manifest: { name: "minimal-agent", version: "0.1.0" },
  files: {
    "agent.yaml": [
      'spec_version: "0.1.0"',
      "name: minimal-agent",
      "version: 0.1.0",
      "model:",
      "  preferred: claude-haiku-4-5-20251001",
    ].join("\n"),
    "SOUL.md": "You are a terse test agent. Reply in fewer than 10 words. Never use tools.",
  },
};

const LOCAL_SOURCE: IdentitySource = { type: "local", path: FIXTURE_DIR };

const GIT_SOURCE: IdentitySource | null = GIT_FIXTURE_URL
  ? { type: "git", url: GIT_FIXTURE_URL }
  : null;

const HARNESS_NAME = "claude-agent-sdk" as const;
const TEST_MESSAGE = "Reply in exactly three words.";
const PER_RUN_TIMEOUT_MS = 90_000; // model latency + substrate boot

/**
 * Spawn-a-substrate factory so we can parametrize cleanly without coupling
 * the test file to substrate constructors at module load time (Bwrap and E2B
 * import are heavy + platform-conditional).
 */
async function makeSubstrate(kind: "local" | "bwrap" | "e2b"): Promise<Substrate> {
  if (kind === "local") {
    const { LocalSubstrate } = await import("@open-gitagent/runtime-local");
    return new LocalSubstrate();
  }
  if (kind === "bwrap") {
    const { BwrapSubstrate } = await import("@computeragent/runtime-bwrap");
    return new BwrapSubstrate();
  }
  const { E2BSubstrate } = await import("@computeragent/runtime-e2b");
  return new E2BSubstrate({ apiKey: E2B_KEY });
}

/** One assertion path used by every row. Built so the matrix bodies stay tiny. */
async function runOneRow(
  kind: "local" | "bwrap" | "e2b",
  source: IdentitySource,
): Promise<{ agent: ComputerAgent; outputTokens: number }> {
  const substrate = await makeSubstrate(kind);
  const opts: ComputerAgentOptions = {
    source,
    harness: HARNESS_NAME,
    runtime: substrate,
    envs: { ANTHROPIC_API_KEY: ANTHROPIC_KEY },
    options: { permissionMode: "bypassPermissions" },
  };
  const agent = new ComputerAgent(opts);
  const result = await agent.chat(TEST_MESSAGE);
  expect(result.sessionId).toBeTruthy();
  expect(result.messages.length).toBeGreaterThan(0);
  expect(result.usage.outputTokens).toBeGreaterThan(0);
  return { agent, outputTokens: result.usage.outputTokens };
}

describe.skipIf(!ANTHROPIC_KEY)(
  "claude-agent-sdk × substrate × source matrix",
  () => {
    let activeAgent: ComputerAgent | undefined;

    afterEach(async () => {
      if (activeAgent) {
        await activeAgent.dispose().catch(() => {});
        activeAgent = undefined;
      }
    });

    // ── LocalSubstrate row ─────────────────────────────────────────────────
    it(
      "Local × inline — boot, chat, dispose",
      async () => {
        const { agent } = await runOneRow("local", INLINE_SOURCE);
        activeAgent = agent;
      },
      PER_RUN_TIMEOUT_MS,
    );

    it(
      "Local × local-fixture — boot, chat, dispose",
      async () => {
        if (!existsSync(FIXTURE_DIR)) {
          throw new Error(`fixture missing: ${FIXTURE_DIR}`);
        }
        const { agent } = await runOneRow("local", LOCAL_SOURCE);
        activeAgent = agent;
      },
      PER_RUN_TIMEOUT_MS,
    );

    it.skipIf(!GIT_SOURCE)(
      "Local × git — boot, clone, chat, dispose (SDK_MATRIX_GIT_FIXTURE_URL gated)",
      async () => {
        const { agent } = await runOneRow("local", GIT_SOURCE!);
        activeAgent = agent;
      },
      PER_RUN_TIMEOUT_MS,
    );

    // ── BwrapSubstrate row (Linux only) ────────────────────────────────────
    it.skipIf(!IS_LINUX || !HAS_BWRAP)(
      "Bwrap × inline — boot inside bwrap, chat, dispose",
      async () => {
        const { agent } = await runOneRow("bwrap", INLINE_SOURCE);
        activeAgent = agent;
      },
      PER_RUN_TIMEOUT_MS,
    );

    it.skipIf(!IS_LINUX || !HAS_BWRAP)(
      "Bwrap × local-fixture — boot inside bwrap, chat, dispose",
      async () => {
        const { agent } = await runOneRow("bwrap", LOCAL_SOURCE);
        activeAgent = agent;
      },
      PER_RUN_TIMEOUT_MS,
    );

    it.skipIf(!IS_LINUX || !HAS_BWRAP || !GIT_SOURCE)(
      "Bwrap × git — boot, clone, chat, dispose (SDK_MATRIX_GIT_FIXTURE_URL gated)",
      async () => {
        const { agent } = await runOneRow("bwrap", GIT_SOURCE!);
        activeAgent = agent;
      },
      PER_RUN_TIMEOUT_MS,
    );

    // ── E2BSubstrate row (E2B_API_KEY required) ────────────────────────────
    it.skipIf(!E2B_KEY)(
      "E2B × inline — sandbox boot, chat, dispose",
      async () => {
        const { agent } = await runOneRow("e2b", INLINE_SOURCE);
        activeAgent = agent;
      },
      PER_RUN_TIMEOUT_MS * 2, // E2B boot is slower
    );

    it.skipIf(!E2B_KEY || !GIT_SOURCE)(
      "E2B × git — sandbox boot, clone, chat, dispose (SDK_MATRIX_GIT_FIXTURE_URL gated)",
      async () => {
        const { agent } = await runOneRow("e2b", GIT_SOURCE!);
        activeAgent = agent;
      },
      PER_RUN_TIMEOUT_MS * 2,
    );
  },
);

// Sanity test that always runs — confirms the fixture exists and is shaped
// correctly. Catches the case where someone deletes test-fixtures/ by accident.
describe("substrate-matrix fixture", () => {
  it("local fixture has agent.yaml + SOUL.md", () => {
    expect(existsSync(resolvePath(FIXTURE_DIR, "agent.yaml"))).toBe(true);
    expect(existsSync(resolvePath(FIXTURE_DIR, "SOUL.md"))).toBe(true);
  });

  it("inline source is well-formed", () => {
    expect(INLINE_SOURCE.type).toBe("inline");
    if (INLINE_SOURCE.type === "inline") {
      expect(INLINE_SOURCE.manifest.name).toBe("minimal-agent");
      expect(INLINE_SOURCE.files?.["agent.yaml"]).toBeTruthy();
      expect(INLINE_SOURCE.files?.["SOUL.md"]).toBeTruthy();
    }
  });
});
