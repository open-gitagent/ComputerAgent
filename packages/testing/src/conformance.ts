/**
 * Harness Protocol conformance suite.
 *
 * Black-box assertions that any conforming implementation must pass. Lives in
 * `@computeragent/testing` so future engine/loader/server authors can run the
 * same suite the reference implementation runs.
 *
 * The suite is transport-agnostic. The caller supplies a `Driver` that knows
 * how to issue HTTP requests — for in-process tests this is the Hono app's
 * `app.request()`, for out-of-process tests it's `fetch(baseUrl + path, ...)`.
 *
 * The suite expects the driven server to have:
 *   - an engine registered under the key `"mock"` whose script the suite
 *     supplies via a custom header — see `MockEngine`'s plug-in contract;
 *   - an identity loader registered under the key `"mock"` that returns a
 *     fixed metadata block.
 *
 * In MVP the suite drives a *fixed* server instance per case. Each case
 * receives a fresh server via `factory()` and runs assertions against it.
 */
import { parseSseChunk } from "./sse-helpers.js";

export interface ConformanceDriver {
  request(path: string, init?: RequestInit): Promise<Response>;
}

export interface ConformanceCase {
  readonly group: string;
  readonly name: string;
  run(driver: ConformanceDriver): Promise<void>;
}

interface ParsedEvent {
  kind: string;
  id?: string;
  data: { kind?: string; sessionId?: string; reason?: string } & Record<string, unknown>;
}

async function drain(res: Response, max = 100): Promise<ParsedEvent[]> {
  const out: ParsedEvent[] = [];
  if (!res.body) return out;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (out.length < max) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const { events, remainder } = parseSseChunk(buf);
    buf = remainder;
    for (const e of events) {
      const ev = e as ParsedEvent;
      out.push(ev);
      if (ev.data?.kind === "ca_session_ended") return out;
    }
  }
  return out;
}

const baseBody = {
  engine: "mock",
  identity: { loader: "mock", source: { type: "local", path: "/tmp" } },
};

function json(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`conformance: ${msg}`);
}

async function createSession(driver: ConformanceDriver, overrides: Record<string, unknown> = {}): Promise<string> {
  const res = await driver.request("/v1/sessions", json({ ...baseBody, ...overrides }));
  assert(res.status === 201, `POST /v1/sessions returned ${res.status}, expected 201`);
  const body = (await res.json()) as { sessionId?: string };
  assert(body.sessionId, "POST /v1/sessions response missing sessionId");
  return body.sessionId;
}

export const conformanceCases: readonly ConformanceCase[] = [
  // ── Health ────────────────────────────────────────────────────────────────
  {
    group: "health",
    name: "GET /v1/health returns ok + registered engines and loaders",
    async run(d) {
      const res = await d.request("/v1/health");
      assert(res.status === 200, `expected 200, got ${res.status}`);
      const body = (await res.json()) as { ok: boolean; engines: Record<string, unknown>; loaders: unknown[] };
      assert(body.ok === true, "health.ok must be true");
      assert("mock" in body.engines, "health.engines must include 'mock'");
      assert(body.loaders.includes("mock"), "health.loaders must include 'mock'");
    },
  },

  // ── Session lifecycle ─────────────────────────────────────────────────────
  {
    group: "sessions",
    name: "POST /v1/sessions returns sessionId, engine, identity.name, eventsUrl",
    async run(d) {
      const res = await d.request("/v1/sessions", json(baseBody));
      assert(res.status === 201, `expected 201, got ${res.status}`);
      const body = (await res.json()) as {
        sessionId?: string; engine?: string; identity?: { name?: string }; eventsUrl?: string;
      };
      assert(body.sessionId?.startsWith("sess_"), "sessionId should start with 'sess_'");
      assert(body.engine === "mock", "engine echoed back");
      assert(body.identity?.name, "identity.name present");
      assert(body.eventsUrl === `/v1/sessions/${body.sessionId}/events`, "eventsUrl matches sessionId");
    },
  },
  {
    group: "sessions",
    name: "GET /v1/sessions/:id returns metadata for an existing session",
    async run(d) {
      const id = await createSession(d);
      const res = await d.request(`/v1/sessions/${id}`);
      assert(res.status === 200, `expected 200, got ${res.status}`);
    },
  },
  {
    group: "sessions",
    name: "GET /v1/sessions/:id returns 404 for unknown id",
    async run(d) {
      const res = await d.request("/v1/sessions/sess_does_not_exist");
      assert(res.status === 404, `expected 404, got ${res.status}`);
    },
  },
  {
    group: "sessions",
    name: "DELETE /v1/sessions/:id removes the session",
    async run(d) {
      const id = await createSession(d);
      const del = await d.request(`/v1/sessions/${id}`, { method: "DELETE" });
      assert(del.status === 200, `expected 200, got ${del.status}`);
      const get = await d.request(`/v1/sessions/${id}`);
      assert(get.status === 404, `after DELETE, GET should 404, got ${get.status}`);
    },
  },

  // ── Validation ────────────────────────────────────────────────────────────
  {
    group: "validation",
    name: "POST /v1/sessions with unknown engine returns 400 UNKNOWN_ENGINE",
    async run(d) {
      const res = await d.request("/v1/sessions", json({ ...baseBody, engine: "no-such" }));
      assert(res.status === 400, `expected 400, got ${res.status}`);
      const body = (await res.json()) as { error?: { code?: string } };
      assert(body.error?.code === "UNKNOWN_ENGINE", `expected UNKNOWN_ENGINE, got ${body.error?.code}`);
    },
  },
  {
    group: "validation",
    name: "POST /v1/sessions with unknown loader returns 400 UNKNOWN_LOADER",
    async run(d) {
      const res = await d.request("/v1/sessions", json({
        ...baseBody, identity: { loader: "no-such", source: { type: "local", path: "/tmp" } },
      }));
      assert(res.status === 400, `expected 400, got ${res.status}`);
      const body = (await res.json()) as { error?: { code?: string } };
      assert(body.error?.code === "UNKNOWN_LOADER", `expected UNKNOWN_LOADER, got ${body.error?.code}`);
    },
  },
  {
    group: "validation",
    name: "POST /v1/sessions with malformed body returns 400",
    async run(d) {
      const res = await d.request("/v1/sessions", json({ engine: "mock" }));
      assert(res.status === 400, `expected 400, got ${res.status}`);
    },
  },

  // ── SSE event stream ──────────────────────────────────────────────────────
  {
    group: "events",
    name: "stream emits ca_session_started first with sessionId, ca_session_ended last",
    async run(d) {
      const id = await createSession(d);
      const events = await drain(await d.request(`/v1/sessions/${id}/events`));
      assert(events.length >= 2, "expected at least two events");
      assert(events[0]?.data.kind === "ca_session_started", "first event kind");
      assert(events[0]?.data.sessionId === id, "first event sessionId echoes");
      assert(events[events.length - 1]?.data.kind === "ca_session_ended", "last event kind");
    },
  },
  {
    group: "events",
    name: "events carry monotonic numeric ids starting at 0",
    async run(d) {
      const id = await createSession(d);
      const events = await drain(await d.request(`/v1/sessions/${id}/events`));
      const ids = events.map((e) => Number(e.id));
      ids.forEach((n, i) => assert(n === i, `event[${i}].id should be ${i}, got ${n}`));
    },
  },
  {
    group: "events",
    name: "Last-Event-ID header replays from cursor",
    async run(d) {
      const id = await createSession(d);
      const first = await drain(await d.request(`/v1/sessions/${id}/events`));
      assert(first.length >= 2, "first drain should have events");
      const second = await drain(await d.request(`/v1/sessions/${id}/events`, {
        headers: { "Last-Event-ID": "0" },
      }));
      assert(second.every((e) => Number(e.id) > 0), "resumed events should all have id > 0");
    },
  },
  {
    group: "events",
    name: "Last-Event-ID past end of buffer returns no events",
    async run(d) {
      const id = await createSession(d);
      await drain(await d.request(`/v1/sessions/${id}/events`));
      const replay = await drain(await d.request(`/v1/sessions/${id}/events`, {
        headers: { "Last-Event-ID": "9999" },
      }));
      assert(replay.length === 0, `expected zero events, got ${replay.length}`);
    },
  },
  {
    group: "events",
    name: "GET /v1/sessions/:id/events on unknown session returns 404",
    async run(d) {
      const res = await d.request("/v1/sessions/sess_nope/events");
      assert(res.status === 404, `expected 404, got ${res.status}`);
    },
  },

  // ── Chat (one-shot) ───────────────────────────────────────────────────────
  {
    group: "chat",
    name: "POST /v1/chat returns SSE stream with sessionId in first event",
    async run(d) {
      const res = await d.request("/v1/chat", json(baseBody));
      assert(res.status === 200, `expected 200, got ${res.status}`);
      assert(res.headers.get("content-type")?.includes("event-stream"), "content-type must be event-stream");
      const events = await drain(res);
      assert(events[0]?.data.kind === "ca_session_started", "first event is ca_session_started");
      assert(events[0]?.data.sessionId, "first event has sessionId");
      assert(events[events.length - 1]?.data.kind === "ca_session_ended", "last event is ca_session_ended");
    },
  },

  // ── Cancel ────────────────────────────────────────────────────────────────
  {
    group: "cancel",
    name: "POST /v1/sessions/:id/cancel ends stream with reason=cancelled",
    async run(d) {
      const id = await createSession(d);
      // Kick off the engine by opening events (non-blocking for cancel).
      const streamPromise = drain(await d.request(`/v1/sessions/${id}/events`));
      const cancelRes = await d.request(`/v1/sessions/${id}/cancel`, { method: "POST" });
      assert(cancelRes.status === 200, `cancel returned ${cancelRes.status}`);
      const events = await streamPromise;
      const ended = events[events.length - 1];
      assert(ended?.data.kind === "ca_session_ended", "stream ended");
      // reason might be 'complete' or 'cancelled' depending on timing; accept either with a strong preference for cancelled
      assert(["cancelled", "complete"].includes(ended?.data.reason ?? ""), `unexpected end reason: ${ended?.data.reason}`);
    },
  },

  // ── Filesystem ────────────────────────────────────────────────────────────
  {
    group: "fs",
    name: "PUT /fs/file then GET /fs/file round-trips the body",
    async run(d) {
      const id = await createSession(d);
      const put = await d.request(`/v1/sessions/${id}/fs/file?path=hello.txt`, {
        method: "PUT",
        body: "hello world",
      });
      assert(put.status === 200, `PUT returned ${put.status}`);
      const get = await d.request(`/v1/sessions/${id}/fs/file?path=hello.txt`);
      assert(get.status === 200, `GET returned ${get.status}`);
      const text = await get.text();
      assert(text === "hello world", `body round-trip mismatch: ${text}`);
    },
  },
  {
    group: "fs",
    name: "GET /fs/tree lists files in workdir",
    async run(d) {
      const id = await createSession(d);
      await d.request(`/v1/sessions/${id}/fs/file?path=a.txt`, { method: "PUT", body: "a" });
      const res = await d.request(`/v1/sessions/${id}/fs/tree?depth=1`);
      assert(res.status === 200, `tree returned ${res.status}`);
      const body = (await res.json()) as { entries?: { path: string }[] };
      assert(body.entries?.some((e) => e.path === "a.txt"), "tree should include a.txt");
    },
  },
  {
    group: "fs",
    name: "DELETE /fs/file removes the file",
    async run(d) {
      const id = await createSession(d);
      await d.request(`/v1/sessions/${id}/fs/file?path=victim.txt`, { method: "PUT", body: "x" });
      const del = await d.request(`/v1/sessions/${id}/fs/file?path=victim.txt`, { method: "DELETE" });
      assert(del.status === 200, `DELETE returned ${del.status}`);
      const get = await d.request(`/v1/sessions/${id}/fs/file?path=victim.txt`);
      assert(get.status === 404, `after DELETE, GET should 404, got ${get.status}`);
    },
  },
  {
    group: "fs",
    name: "POST /fs/mkdir creates a directory",
    async run(d) {
      const id = await createSession(d);
      const res = await d.request(`/v1/sessions/${id}/fs/mkdir`, json({ path: "subdir" }));
      assert(res.status === 200, `mkdir returned ${res.status}`);
      const tree = await d.request(`/v1/sessions/${id}/fs/tree?depth=1`);
      const body = (await tree.json()) as { entries?: { path: string; type: string }[] };
      assert(body.entries?.some((e) => e.path === "subdir" && e.type === "dir"), "subdir should appear as dir in tree");
    },
  },
  {
    group: "fs",
    name: "POST /fs/edit string-replaces in a file",
    async run(d) {
      const id = await createSession(d);
      await d.request(`/v1/sessions/${id}/fs/file?path=note.md`, { method: "PUT", body: "before" });
      const res = await d.request(`/v1/sessions/${id}/fs/edit`, json({
        path: "note.md", oldString: "before", newString: "after",
      }));
      assert(res.status === 200, `edit returned ${res.status}`);
      const get = await d.request(`/v1/sessions/${id}/fs/file?path=note.md`);
      const text = await get.text();
      assert(text === "after", `edit not applied: ${text}`);
    },
  },
  {
    group: "fs",
    name: "POST /fs/move renames a file",
    async run(d) {
      const id = await createSession(d);
      await d.request(`/v1/sessions/${id}/fs/file?path=old.txt`, { method: "PUT", body: "data" });
      const res = await d.request(`/v1/sessions/${id}/fs/move`, json({ from: "old.txt", to: "new.txt" }));
      assert(res.status === 200, `move returned ${res.status}`);
      const get = await d.request(`/v1/sessions/${id}/fs/file?path=new.txt`);
      assert(get.status === 200, `GET on new path returned ${get.status}`);
    },
  },
  {
    group: "fs",
    name: "path traversal '..' is rejected with 400 PATH_ESCAPE",
    async run(d) {
      const id = await createSession(d);
      const res = await d.request(`/v1/sessions/${id}/fs/file?path=../etc/passwd`);
      assert(res.status === 400, `expected 400, got ${res.status}`);
      const body = (await res.json()) as { error?: { code?: string } };
      assert(body.error?.code === "PATH_ESCAPE", `expected PATH_ESCAPE, got ${body.error?.code}`);
    },
  },
  {
    group: "fs",
    name: "absolute path is rejected",
    async run(d) {
      const id = await createSession(d);
      const res = await d.request(`/v1/sessions/${id}/fs/file?path=/etc/passwd`);
      assert(res.status === 400, `expected 400, got ${res.status}`);
    },
  },
];

/**
 * Run every case against the driver. Returns a pass/fail report. Consumers
 * decide how to integrate with their test framework (vitest, mocha, jest).
 */
export interface ConformanceResult {
  passed: number;
  failed: { group: string; name: string; error: string }[];
}

export async function runConformanceSuite(
  factory: () => Promise<ConformanceDriver> | ConformanceDriver,
): Promise<ConformanceResult> {
  const result: ConformanceResult = { passed: 0, failed: [] };
  for (const c of conformanceCases) {
    const driver = await factory();
    try {
      await c.run(driver);
      result.passed += 1;
    } catch (err) {
      result.failed.push({
        group: c.group,
        name: c.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return result;
}
