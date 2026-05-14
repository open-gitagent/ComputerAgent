/**
 * Run the published @computeragent/testing conformance suite against the
 * reference harness-server implementation.
 *
 * Each case gets a fresh server with the same MockEngine script the suite
 * was designed for (a couple of `emit` steps so SSE round-trips are
 * exercise-able). Third-party engine/loader/server authors run this same
 * suite to validate that their implementation honors the Harness Protocol.
 */
import { describe, expect, it } from "vitest";
import {
  conformanceCases,
  MockEngine,
  MockLoader,
  type ConformanceDriver,
} from "@computeragent/testing";
import { createHarnessServer } from "./app.js";

function freshDriver(): ConformanceDriver {
  const engine = new MockEngine([
    { kind: "emit", payload: { type: "system" } },
    { kind: "emit", payload: { type: "assistant", text: "hello" } },
  ]);
  const app = createHarnessServer({
    engines: { mock: engine },
    identityLoaders: { mock: new MockLoader({ metadata: { name: "test", version: "0.0.1" } }) },
  });
  return {
    request: (path, init) => app.request(path, init),
  };
}

describe("conformance suite (reference impl)", () => {
  for (const c of conformanceCases) {
    it(`[${c.group}] ${c.name}`, async () => {
      await c.run(freshDriver());
    });
  }
});

describe("runConformanceSuite helper", () => {
  it("returns a pass/fail report", async () => {
    const { runConformanceSuite } = await import("@computeragent/testing");
    const report = await runConformanceSuite(() => freshDriver());
    expect(report.failed).toEqual([]);
    expect(report.passed).toBe(conformanceCases.length);
  });
});
