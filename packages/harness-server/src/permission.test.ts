import { describe, expect, it } from "vitest";
import { MockEngine, MockLoader, parseSseChunk } from "@computeragent/testing";
import { createHarnessServer } from "./app.js";

const baseBody = {
  engine: "mock",
  identity: { loader: "mock", source: { type: "local", path: "/tmp" } },
};

function makeApp(engine: MockEngine) {
  return createHarnessServer({
    engines: { mock: engine },
    identityLoaders: { mock: new MockLoader() },
  });
}

async function readEvents(res: Response, max = 50) {
  const out: { kind: string; data: Record<string, unknown> }[] = [];
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (out.length < max) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const { events, remainder } = parseSseChunk(buf);
    buf = remainder;
    for (const e of events) {
      out.push({ kind: e.kind, data: e.data as Record<string, unknown> });
      const data = e.data as { kind?: string };
      if (data?.kind === "ca_session_ended") return out;
    }
  }
  return out;
}

describe("permission round-trip", () => {
  it("emits ca_permission_request, accepts /permission POST, engine resumes", async () => {
    const engine = new MockEngine([
      { kind: "emit", payload: { type: "system" } },
      { kind: "ask_permission", toolName: "Bash", expect: "allow" },
      { kind: "emit", payload: { type: "assistant", text: "tool ran" } },
    ]);
    const app = makeApp(engine);

    const created = await app.request("/v1/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(baseBody),
    });
    const { sessionId } = (await created.json()) as { sessionId: string };

    // Open events stream; engine will run until permission step then block.
    const eventsP = app.request(`/v1/sessions/${sessionId}/events`);

    // Collect events until we see ca_permission_request, then answer.
    const decoder = new TextDecoder();
    const eventsRes = await eventsP;
    const reader = eventsRes.body!.getReader();
    const collected: { kind: string; data: Record<string, unknown> }[] = [];
    let buf = "";
    let answered = false;

    while (collected.length < 50) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const { events, remainder } = parseSseChunk(buf);
      buf = remainder;
      for (const e of events) {
        collected.push({ kind: e.kind, data: e.data as Record<string, unknown> });
        if (!answered && e.kind === "ca_permission_request") {
          answered = true;
          const callId = (e.data as { callId: string }).callId;
          await app.request(`/v1/sessions/${sessionId}/permission/${callId}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ decision: "allow" }),
          });
        }
        if (e.kind === "ca_session_ended") {
          const kinds = collected.map((c) => c.kind);
          expect(kinds).toContain("ca_permission_request");
          expect(kinds[kinds.length - 1]).toBe("ca_session_ended");
          const ended = collected[collected.length - 1]?.data as { reason: string };
          expect(ended.reason).toBe("complete");
          expect(engine.received.permissions).toHaveLength(1);
          expect(engine.received.permissions[0]?.toolName).toBe("Bash");
          return;
        }
      }
    }
    throw new Error("never reached ca_session_ended");
  });

  it("404s on unknown session", async () => {
    const app = makeApp(new MockEngine([]));
    const res = await app.request("/v1/sessions/sess_nope/permission/call_1", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "allow" }),
    });
    expect(res.status).toBe(404);
  });

  it("400s on unknown callId", async () => {
    const engine = new MockEngine([{ kind: "emit", payload: {} }]);
    const app = makeApp(engine);
    const created = await app.request("/v1/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(baseBody),
    });
    const { sessionId } = (await created.json()) as { sessionId: string };

    // Open events first so the session exists in a runnable state, then drain in bg.
    const drain = readEvents(await app.request(`/v1/sessions/${sessionId}/events`));

    const res = await app.request(`/v1/sessions/${sessionId}/permission/no-such-call`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "allow" }),
    });
    expect(res.status).toBe(400);
    await drain;
  });
});
