import { describe, it, expect, afterEach } from "vitest";
import { configure, shutdown, getConfig, getTracer, getMeter } from "./provider.js";

afterEach(async () => {
  await shutdown(1_000);
});

describe("configure/shutdown lifecycle", () => {
  it("boots with the 'none' exporter for tests", () => {
    const cfg = configure({ exporter: "none", serviceName: "test-svc" });
    expect(cfg.serviceName).toBe("test-svc");
    expect(getConfig()?.serviceName).toBe("test-svc");
  });

  it("is idempotent — a second configure returns the first config", () => {
    const a = configure({ exporter: "none", serviceName: "first" });
    const b = configure({ exporter: "none", serviceName: "second" });
    expect(a).toBe(b);
    expect(b.serviceName).toBe("first");
  });

  it("clears state after shutdown so configure can be called again", async () => {
    configure({ exporter: "none", serviceName: "before" });
    await shutdown(1_000);
    expect(getConfig()).toBeUndefined();
    const cfg = configure({ exporter: "none", serviceName: "after" });
    expect(cfg.serviceName).toBe("after");
  });

  it("exposes a tracer and a meter", () => {
    configure({ exporter: "none" });
    expect(typeof getTracer().startSpan).toBe("function");
    expect(typeof getMeter().createHistogram).toBe("function");
  });

  it("shutdown is safe when nothing has been configured", async () => {
    await expect(shutdown(500)).resolves.toBeUndefined();
  });
});
