import { afterEach, describe, expect, it } from "vitest";
import { LocalSubstrate } from "./local-substrate.js";

let booted: { shutdown: () => Promise<void> } | undefined;

afterEach(async () => {
  if (booted) await booted.shutdown();
  booted = undefined;
});

describe("LocalSubstrate", () => {
  it("boots a harness subprocess, exposes /v1/health, then shuts down cleanly", async () => {
    const substrate = new LocalSubstrate({ readinessTimeoutMs: 15_000 });
    booted = await substrate.bootHarness({ envs: {} });
    expect(booted.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    const res = await fetch(`${booted.baseUrl}/v1/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; engines: Record<string, unknown>; loaders: string[] };
    expect(body.ok).toBe(true);
    expect(Object.keys(body.engines)).toContain("claude-agent-sdk");
    expect(Object.keys(body.engines)).toContain("gitagent");
    expect(body.loaders).toContain("gitagentprotocol");
  }, 30_000);

  it("two bootHarness calls land on different ports", async () => {
    const substrate = new LocalSubstrate({ readinessTimeoutMs: 15_000 });
    const a = await substrate.bootHarness({ envs: {} });
    const b = await substrate.bootHarness({ envs: {} });
    try {
      expect(a.baseUrl).not.toBe(b.baseUrl);
      const [ra, rb] = await Promise.all([
        fetch(`${a.baseUrl}/v1/health`).then((r) => r.status),
        fetch(`${b.baseUrl}/v1/health`).then((r) => r.status),
      ]);
      expect(ra).toBe(200);
      expect(rb).toBe(200);
    } finally {
      await Promise.all([a.shutdown(), b.shutdown()]);
    }
  }, 30_000);

  it("shutdown() is idempotent", async () => {
    const substrate = new LocalSubstrate({ readinessTimeoutMs: 15_000 });
    booted = await substrate.bootHarness({ envs: {} });
    await booted.shutdown();
    await booted.shutdown();
    expect(true).toBe(true);
  }, 30_000);
});
