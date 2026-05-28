import { describe, expect, it } from "vitest";
import type { EngineContext } from "@open-gitagent/protocol";
import { MockEngine, MockLoader, collectSseEvents } from "@computeragent/testing";
import { createHarnessServer } from "./app.js";

interface ObservedOpts { permissionMode?: string; [k: string]: unknown }

function captureEngineOptions() {
  const inner = new MockEngine([{ kind: "emit", payload: { type: "system" } }]);
  let captured: ObservedOpts | undefined;
  const wrapped = {
    name: inner.name,
    capabilities: inner.capabilities,
    async *startSession(ctx: EngineContext<unknown>) {
      captured = ctx.options as ObservedOpts;
      for await (const ev of inner.startSession(ctx)) yield ev;
    },
  };
  return { engine: wrapped, getCaptured: () => captured };
}

const baseBody = {
  engine: "mock",
  identity: { loader: "mock", source: { type: "local", path: "/tmp" } },
};

describe("loader.harden integration — compliance overrides reach the engine", () => {
  it("loader.harden() output is what the engine ultimately sees", async () => {
    // MockLoader with a harden function that always rewrites permissionMode
    // — this proves the loader.harden hook is plumbed into createSession.
    const loader = new MockLoader({
      options: { permissionMode: "bypassPermissions", model: "from-loader" },
      harden: (merged) => {
        const m = merged as Record<string, unknown>;
        if (m.permissionMode === "bypassPermissions") {
          return { ...m, permissionMode: "default" };
        }
        return merged;
      },
    });
    const { engine, getCaptured } = captureEngineOptions();
    const app = createHarnessServer({
      engines: { mock: engine },
      identityLoaders: { mock: loader },
    });

    // Caller tries to bypass permissions; loader.harden() must overrule.
    const create = await app.request("/v1/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...baseBody, options: { permissionMode: "bypassPermissions" } }),
    });
    const { sessionId } = (await create.json()) as { sessionId: string };

    const res = await app.request(`/v1/sessions/${sessionId}/events`);
    await collectSseEvents(res.body!);

    expect(getCaptured()?.permissionMode).toBe("default");
  });

  it("absent harden() returns options unchanged (back-compat)", async () => {
    const loader = new MockLoader({
      options: { permissionMode: "default" },
      // no harden — fall back to identity behavior
    });
    const { engine, getCaptured } = captureEngineOptions();
    const app = createHarnessServer({
      engines: { mock: engine },
      identityLoaders: { mock: loader },
    });
    const create = await app.request("/v1/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...baseBody, options: { permissionMode: "bypassPermissions" } }),
    });
    const { sessionId } = (await create.json()) as { sessionId: string };
    const res = await app.request(`/v1/sessions/${sessionId}/events`);
    await collectSseEvents(res.body!);

    expect(getCaptured()?.permissionMode).toBe("bypassPermissions");
  });
});
