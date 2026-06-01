// Tests for the TRACE_BACKEND env var selector. Verifies parse + cache +
// error semantics. Uses the test hook to reset the cached value between cases.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { _setTraceBackendForTests, traceBackend } from "./trace-backend.js";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  delete process.env["TRACE_BACKEND"];
  _setTraceBackendForTests(null);
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  _setTraceBackendForTests(null);
});

describe("traceBackend()", () => {
  it("defaults to clickhouse when env unset", () => {
    expect(traceBackend()).toBe("clickhouse");
  });

  it("accepts 'clickhouse'", () => {
    process.env["TRACE_BACKEND"] = "clickhouse";
    expect(traceBackend()).toBe("clickhouse");
  });

  it("accepts 'newrelic'", () => {
    process.env["TRACE_BACKEND"] = "newrelic";
    expect(traceBackend()).toBe("newrelic");
  });

  it("is case-insensitive", () => {
    process.env["TRACE_BACKEND"] = "NewRelic";
    expect(traceBackend()).toBe("newrelic");
  });

  it("throws on unknown value", () => {
    process.env["TRACE_BACKEND"] = "honeycomb";
    expect(() => traceBackend()).toThrow(/must be "clickhouse" or "newrelic"/);
  });

  it("caches the first read — env changes after first call do NOT take effect", () => {
    process.env["TRACE_BACKEND"] = "newrelic";
    expect(traceBackend()).toBe("newrelic");
    process.env["TRACE_BACKEND"] = "clickhouse";
    // Still newrelic because we cached it.
    expect(traceBackend()).toBe("newrelic");
  });
});
