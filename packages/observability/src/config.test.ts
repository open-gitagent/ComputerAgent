import { describe, it, expect } from "vitest";
import { parseTracerConfig } from "./config.js";

describe("parseTracerConfig", () => {
  it("applies sensible defaults for an empty input", () => {
    const cfg = parseTracerConfig({});
    expect(cfg.serviceName).toBe("computeragent");
    expect(cfg.exporter).toBe("console");
    expect(cfg.sampleRate).toBe(1.0);
    expect(cfg.captureContent).toBe(false);
    expect(cfg.captureContentMode).toBe("events");
    expect(cfg.metricsEnabled).toBe(true);
    expect(cfg.maxAttributeLength).toBe(4096);
  });

  it("freezes the returned config (deep)", () => {
    const cfg = parseTracerConfig({ serviceName: "frozen-test" });
    expect(Object.isFrozen(cfg)).toBe(true);
    expect(() => {
      // @ts-expect-error — runtime mutation on frozen object
      cfg.serviceName = "mutated";
    }).toThrow();
    expect(Object.isFrozen(cfg.redaction)).toBe(true);
  });

  it("rejects sample rates outside [0, 1]", () => {
    expect(() => parseTracerConfig({ sampleRate: 1.5 })).toThrow();
    expect(() => parseTracerConfig({ sampleRate: -0.1 })).toThrow();
  });

  it("requires endpoint when exporter is otlp-http", () => {
    expect(() => parseTracerConfig({ exporter: "otlp-http" })).toThrow(/endpoint is required/);
    const cfg = parseTracerConfig({
      exporter: "otlp-http",
      endpoint: "https://collector.example/v1/traces",
    });
    expect(cfg.endpoint).toBe("https://collector.example/v1/traces");
  });

  it("requires endpoint when exporter is otlp-grpc", () => {
    expect(() => parseTracerConfig({ exporter: "otlp-grpc" })).toThrow(/endpoint is required/);
  });

  it("permits the 'none' exporter for testing", () => {
    const cfg = parseTracerConfig({ exporter: "none" });
    expect(cfg.exporter).toBe("none");
  });

  it("rejects invalid captureContentMode values", () => {
    expect(() =>
      parseTracerConfig({
        // @ts-expect-error — invalid enum
        captureContentMode: "yolo",
      }),
    ).toThrow();
  });
});
