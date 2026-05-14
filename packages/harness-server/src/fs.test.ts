import { describe, expect, it } from "vitest";
import { MockEngine, MockLoader } from "@computeragent/testing";
import { createHarnessServer } from "./app.js";

const baseBody = {
  engine: "mock",
  identity: { loader: "mock", source: { type: "local", path: "/tmp" } },
};

function makeApp() {
  return createHarnessServer({
    engines: { mock: new MockEngine([]) },
    identityLoaders: { mock: new MockLoader() },
  });
}

async function newSessionId(app: ReturnType<typeof makeApp>): Promise<string> {
  const r = await app.request("/v1/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(baseBody),
  });
  return ((await r.json()) as { sessionId: string }).sessionId;
}

describe("FS routes — happy path", () => {
  it("PUT then GET file round-trips bytes", async () => {
    const app = makeApp();
    const id = await newSessionId(app);
    const put = await app.request(`/v1/sessions/${id}/fs/file?path=hello.txt`, {
      method: "PUT",
      body: "hello world",
    });
    expect(put.status).toBe(200);
    const putBody = (await put.json()) as { ok: boolean; size: number };
    expect(putBody.size).toBe(11);

    const got = await app.request(`/v1/sessions/${id}/fs/file?path=hello.txt`);
    expect(got.status).toBe(200);
    expect(await got.text()).toBe("hello world");
  });

  it("tree lists files with metadata", async () => {
    const app = makeApp();
    const id = await newSessionId(app);
    await app.request(`/v1/sessions/${id}/fs/file?path=a.txt`, { method: "PUT", body: "1" });
    await app.request(`/v1/sessions/${id}/fs/file?path=b.txt`, { method: "PUT", body: "22" });

    const res = await app.request(`/v1/sessions/${id}/fs/tree`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: Array<{ path: string; size: number; type: string }> };
    const names = body.entries.map((e) => e.path).sort();
    expect(names).toContain("a.txt");
    expect(names).toContain("b.txt");
  });

  it("mkdir + tree depth=2 reveals nested files", async () => {
    const app = makeApp();
    const id = await newSessionId(app);
    await app.request(`/v1/sessions/${id}/fs/mkdir`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "deep/nested", recursive: true }),
    });
    await app.request(`/v1/sessions/${id}/fs/file?path=deep/nested/x.txt`, {
      method: "PUT",
      body: "z",
    });

    const tree = await app.request(`/v1/sessions/${id}/fs/tree?depth=3`);
    const entries = ((await tree.json()) as { entries: Array<{ path: string }> }).entries;
    const paths = entries.map((e) => e.path);
    expect(paths.some((p) => p.endsWith("x.txt"))).toBe(true);
  });

  it("edit performs string replace", async () => {
    const app = makeApp();
    const id = await newSessionId(app);
    await app.request(`/v1/sessions/${id}/fs/file?path=note.txt`, { method: "PUT", body: "hello world" });
    const res = await app.request(`/v1/sessions/${id}/fs/edit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "note.txt", oldString: "world", newString: "earth" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { replacements: number };
    expect(body.replacements).toBe(1);

    const got = await app.request(`/v1/sessions/${id}/fs/file?path=note.txt`);
    expect(await got.text()).toBe("hello earth");
  });

  it("move renames a file", async () => {
    const app = makeApp();
    const id = await newSessionId(app);
    await app.request(`/v1/sessions/${id}/fs/file?path=old.txt`, { method: "PUT", body: "x" });
    const res = await app.request(`/v1/sessions/${id}/fs/move`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from: "old.txt", to: "renamed/new.txt" }),
    });
    expect(res.status).toBe(200);

    const got = await app.request(`/v1/sessions/${id}/fs/file?path=renamed/new.txt`);
    expect(await got.text()).toBe("x");
  });

  it("delete removes a file", async () => {
    const app = makeApp();
    const id = await newSessionId(app);
    await app.request(`/v1/sessions/${id}/fs/file?path=victim.txt`, { method: "PUT", body: "x" });
    const del = await app.request(`/v1/sessions/${id}/fs/file?path=victim.txt`, { method: "DELETE" });
    expect(del.status).toBe(200);
    const get = await app.request(`/v1/sessions/${id}/fs/file?path=victim.txt`);
    expect(get.status).toBe(404);
  });
});

describe("FS routes — security", () => {
  it("rejects parent-traversal paths with 400 PATH_ESCAPE", async () => {
    const app = makeApp();
    const id = await newSessionId(app);
    const res = await app.request(`/v1/sessions/${id}/fs/file?path=../../etc/passwd`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("PATH_ESCAPE");
  });

  it("rejects absolute paths with 400 PATH_ESCAPE", async () => {
    const app = makeApp();
    const id = await newSessionId(app);
    const res = await app.request(`/v1/sessions/${id}/fs/file?path=/etc/passwd`);
    expect(res.status).toBe(400);
  });

  it("404s on unknown session", async () => {
    const app = makeApp();
    const res = await app.request(`/v1/sessions/sess_nope/fs/tree`);
    expect(res.status).toBe(404);
  });

  it("requires path query for /file", async () => {
    const app = makeApp();
    const id = await newSessionId(app);
    const res = await app.request(`/v1/sessions/${id}/fs/file`);
    expect(res.status).toBe(400);
  });
});
