/**
 * Live-Mongo integration tests for `AgentLogStore`. Same MONGO_URL gate +
 * unique-DB-per-run pattern as registry.test.ts.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { MongoClient } from "mongodb";
import { AgentLogStore, QUERY_MAX, REPLY_MAX } from "./audit-log.js";

const url = process.env.MONGO_URL;
const describeMongo = url ? describe : describe.skip;

describeMongo("AgentLogStore (live)", () => {
  let admin: MongoClient | null = null;
  let dbName: string;

  beforeAll(async () => {
    admin = new MongoClient(url!);
    await admin.connect();
    dbName = `ca_test_logs_${Math.random().toString(36).slice(2, 10)}`;
  });

  afterAll(async () => {
    if (admin) {
      await admin.db(dbName).dropDatabase().catch(() => {});
      await admin.close();
    }
  });

  let store: AgentLogStore;
  afterEach(async () => {
    if (store) await store.close();
    if (admin) await admin.db(dbName).collection("agent_logs").deleteMany({});
  });

  it("append() inserts one doc with the right shape", async () => {
    store = new AgentLogStore({ url: url!, database: dbName });
    await store.append({
      source: "library",
      agentName: "agent-a",
      requester: "library",
      channel: null,
      threadTs: null,
      sessionId: "sess_abc",
      query: "hello",
      reply: "world",
      ok: true,
      durationMs: 1234,
      inputTokens: 50,
      outputTokens: 8,
      costUsd: 0.001,
    });
    const rows = await store.list({ agentName: "agent-a" });
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row._id).toMatch(/^log_/);
    expect(row.ts).toBeInstanceOf(Date);
    expect(row.source).toBe("library");
    expect(row.agentName).toBe("agent-a");
    expect(row.requester).toBe("library");
    expect(row.sessionId).toBe("sess_abc");
    expect(row.query).toBe("hello");
    expect(row.reply).toBe("world");
    expect(row.ok).toBe(true);
    expect(row.durationMs).toBe(1234);
    expect(row.inputTokens).toBe(50);
    expect(row.outputTokens).toBe(8);
    expect(row.costUsd).toBe(0.001);
  });

  it("append() truncates query and reply to their MAX bounds", async () => {
    store = new AgentLogStore({ url: url!, database: dbName });
    const longQuery = "q".repeat(QUERY_MAX + 100);
    const longReply = "r".repeat(REPLY_MAX + 100);
    await store.append({
      source: "library",
      agentName: "agent-trunc",
      requester: null,
      channel: null,
      threadTs: null,
      sessionId: null,
      query: longQuery,
      reply: longReply,
      ok: true,
    });
    const [row] = await store.list({ agentName: "agent-trunc" });
    expect(row!.query.length).toBe(QUERY_MAX);
    expect(row!.query.endsWith("…")).toBe(true);
    expect(row!.reply.length).toBe(REPLY_MAX);
    expect(row!.reply.endsWith("…")).toBe(true);
  });

  it("list() returns newest first and respects limit", async () => {
    store = new AgentLogStore({ url: url!, database: dbName });
    for (let i = 0; i < 5; i++) {
      await store.append({
        source: "library",
        agentName: "agent-order",
        requester: null,
        channel: null,
        threadTs: null,
        sessionId: `sess_${i}`,
        query: `q${i}`,
        reply: `r${i}`,
        ok: true,
      });
      await new Promise((r) => setTimeout(r, 5));
    }
    const rows = await store.list({ agentName: "agent-order", limit: 3 });
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.sessionId)).toEqual(["sess_4", "sess_3", "sess_2"]);
  });

  it("list() clamps limit to [1, 500]", async () => {
    store = new AgentLogStore({ url: url!, database: dbName });
    await store.append({
      source: "library",
      agentName: "agent-clamp",
      requester: null,
      channel: null,
      threadTs: null,
      sessionId: null,
      query: "q",
      reply: "r",
      ok: true,
    });
    // limit 0 → clamped to 1
    expect((await store.list({ agentName: "agent-clamp", limit: 0 })).length).toBe(1);
    // limit 9999 → clamped to 500 (allowed, no error)
    expect((await store.list({ agentName: "agent-clamp", limit: 9999 })).length).toBe(1);
  });

  it("list() filters by source + ok + before", async () => {
    store = new AgentLogStore({ url: url!, database: dbName });
    const before = new Date();
    // 3 rows from "library" + 1 from "slack", mix of ok/error
    await store.append({ source: "library", agentName: "f", requester: null, channel: null, threadTs: null, sessionId: null, query: "a", reply: "", ok: true });
    await store.append({ source: "library", agentName: "f", requester: null, channel: null, threadTs: null, sessionId: null, query: "b", reply: "", ok: false, error: "boom" });
    await store.append({ source: "library", agentName: "f", requester: null, channel: null, threadTs: null, sessionId: null, query: "c", reply: "", ok: true });
    await store.append({ source: "slack",   agentName: "f", requester: null, channel: null, threadTs: null, sessionId: null, query: "d", reply: "", ok: true });
    const after = new Date();

    expect((await store.list({ agentName: "f", source: "library" })).length).toBe(3);
    expect((await store.list({ agentName: "f", source: "slack" })).length).toBe(1);
    expect((await store.list({ agentName: "f", ok: false })).length).toBe(1);
    expect((await store.list({ agentName: "f", before })).length).toBe(0);
    expect((await store.list({ agentName: "f", before: after })).length).toBeGreaterThan(0);
  });

  it("count() returns the same numeric total as a filtered list", async () => {
    store = new AgentLogStore({ url: url!, database: dbName });
    for (let i = 0; i < 4; i++) {
      await store.append({
        source: i % 2 === 0 ? "library" : "slack",
        agentName: "agent-count",
        requester: null,
        channel: null,
        threadTs: null,
        sessionId: null,
        query: "q",
        reply: "r",
        ok: true,
      });
    }
    expect(await store.count({ agentName: "agent-count" })).toBe(4);
    expect(await store.count({ agentName: "agent-count", source: "library" })).toBe(2);
    expect(await store.count({ agentName: "agent-count", source: "slack" })).toBe(2);
  });

  it("close() is idempotent and safe before any I/O", async () => {
    store = new AgentLogStore({ url: url!, database: dbName });
    await store.close();
    await store.close();
  });
});

// Always-on sanity — constructor doesn't connect eagerly.
describe("AgentLogStore — constructor (offline)", () => {
  it("does not throw with a bogus URL", () => {
    const s = new AgentLogStore({ url: "mongodb://nope:27017", database: "x" });
    expect(s).toBeDefined();
  });
});
