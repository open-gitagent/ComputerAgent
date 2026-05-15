import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHarnessServer } from "@computeragent/harness-server";
import { MockEngine, MockLoader } from "@computeragent/testing";
import { ComputerAgent } from "./computer-agent.js";

/**
 * Tests for the artifact-fetch helpers (issue #1):
 *   - agent.fetchArtifact(path) → Uint8Array | null
 *   - agent.fetchArtifactText(path) → string | null
 *   - agent.listWorkdir({path?, depth?}) → FsTreeEntry[]
 *
 * Each test uses a real in-process harness server + MockEngine to mint a
 * sessionId, then writes a file via the harness's PUT /fs/file and asserts
 * the helper reads it back correctly.
 */

let serverHandle: { stop: () => void; url: string } | undefined;

async function bootServer(engine: MockEngine) {
  const { serve } = await import("@hono/node-server");
  const app = createHarnessServer({
    engines: { mock: engine },
    identityLoaders: { mock: new MockLoader({ metadata: { name: "test", version: "0.0.1" } }) },
  });
  return await new Promise<{ stop: () => void; url: string }>((resolve) => {
    const server = serve({ fetch: app.fetch, port: 0 }, ({ port }) => {
      resolve({ stop: () => server.close(), url: `http://127.0.0.1:${port}` });
    });
  });
}

async function bootAgentAndChat(): Promise<{ agent: ComputerAgent; sessionId: string; url: string }> {
  const engine = new MockEngine([{ kind: "emit", payload: { type: "result", result: "ok" } }]);
  serverHandle = await bootServer(engine);
  const url = serverHandle.url;
  const agent = new ComputerAgent({
    source: { type: "local", path: "/tmp" },
    harness: "mock",
    identityLoader: "mock",
    harnessUrl: url,
  });
  const r = await agent.chat("hi");
  return { agent, sessionId: r.sessionId, url };
}

beforeEach(() => { serverHandle = undefined; });
afterEach(() => { serverHandle?.stop(); });

describe("ComputerAgent — artifact helpers (issue #1)", () => {
  it("fetchArtifact returns exact bytes for a binary file in the workdir", async () => {
    const { agent, sessionId, url } = await bootAgentAndChat();
    // Adversarial byte pattern — includes 0x00, high bits, and printable mix.
    const payload = new Uint8Array([0xff, 0x00, 0xaa, 0x55, 0x7f, 0x80, 0x01]);
    const put = await fetch(`${url}/v1/sessions/${sessionId}/fs/file?path=blob.bin`, {
      method: "PUT",
      body: payload,
    });
    expect(put.ok).toBe(true);

    const bytes = await agent.fetchArtifact("blob.bin");
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(Array.from(bytes!)).toEqual(Array.from(payload));
  });

  it("fetchArtifact returns null when the file doesn't exist", async () => {
    const { agent } = await bootAgentAndChat();
    const bytes = await agent.fetchArtifact("nope/missing.bin");
    expect(bytes).toBeNull();
  });

  it("fetchArtifactText round-trips a UTF-8 file", async () => {
    const { agent, sessionId, url } = await bootAgentAndChat();
    const text = "# Report\n\nLine 2 with emoji 💀 and unicode 你好\n";
    await fetch(`${url}/v1/sessions/${sessionId}/fs/file?path=report.md`, {
      method: "PUT",
      body: text,
    });
    const got = await agent.fetchArtifactText("report.md");
    expect(got).toBe(text);
  });

  it("fetchArtifactText returns null for missing file", async () => {
    const { agent } = await bootAgentAndChat();
    const got = await agent.fetchArtifactText("not-here.md");
    expect(got).toBeNull();
  });

  it("listWorkdir returns FsTreeEntry[] including written files", async () => {
    const { agent, sessionId, url } = await bootAgentAndChat();
    await fetch(`${url}/v1/sessions/${sessionId}/fs/file?path=a.txt`, { method: "PUT", body: "1" });
    await fetch(`${url}/v1/sessions/${sessionId}/fs/file?path=b.txt`, { method: "PUT", body: "22" });

    const entries = await agent.listWorkdir();
    const paths = entries.map((e) => e.path);
    expect(paths).toContain("a.txt");
    expect(paths).toContain("b.txt");
    const a = entries.find((e) => e.path === "a.txt")!;
    expect(a.type).toBe("file");
    expect(a.size).toBe(1);
  });

  it("listWorkdir respects depth", async () => {
    const { agent, sessionId, url } = await bootAgentAndChat();
    await fetch(`${url}/v1/sessions/${sessionId}/fs/file?path=deep/nested/x.txt`, {
      method: "PUT",
      body: "deep",
    });
    const shallow = await agent.listWorkdir({ depth: 1 });
    // depth=1 should NOT see deep/nested/x.txt — only the top-level "deep" dir.
    expect(shallow.find((e) => e.path === "deep/nested/x.txt")).toBeUndefined();
    expect(shallow.find((e) => e.path === "deep")?.type).toBe("dir");

    const deep = await agent.listWorkdir({ depth: 5 });
    expect(deep.find((e) => e.path === "deep/nested/x.txt")?.type).toBe("file");
  });

  it("path traversal in fetchArtifact path is rejected by the harness (jailed)", async () => {
    const { agent } = await bootAgentAndChat();
    // The harness rejects "..", so this throws via asHarnessError (not just returns null).
    await expect(agent.fetchArtifact("../etc/passwd")).rejects.toThrow();
  });

  it("fetchArtifact throws a clear error when no session has started yet", async () => {
    const engine = new MockEngine([]);
    serverHandle = await bootServer(engine);
    const agent = new ComputerAgent({
      source: { type: "local", path: "/tmp" },
      harness: "mock",
      identityLoader: "mock",
      harnessUrl: serverHandle.url,
    });
    // No chat() call yet → no sessionId.
    await expect(agent.fetchArtifact("anything.bin")).rejects.toThrow(/no session yet/);
    await expect(agent.fetchArtifactText("anything.md")).rejects.toThrow(/no session yet/);
    await expect(agent.listWorkdir()).rejects.toThrow(/no session yet/);
  });
});
