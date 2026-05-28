/**
 * Live-Mongo integration tests for `MongoTelemetry` — the headline class that
 * makes library-mode tracking work. Same MONGO_URL gate as the other tests.
 *
 * Each test directly drives the AgentTelemetry hooks the SDK would call,
 * then reads back from Mongo to confirm the right collections got the right
 * writes. We don't boot a real ComputerAgent here — that's covered by
 * packages/sdk/src/telemetry-hook.test.ts; this file is about the *Mongo
 * write* path.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { MongoClient } from "mongodb";
import type { AgentConstructedInfo, ChatEndInfo, ChatStartInfo } from "@computeragent/sdk";
import { AgentLogStore } from "./audit-log.js";
import { AgentRegistry } from "./registry.js";
import { MongoTelemetry } from "./telemetry.js";

const url = process.env.MONGO_URL;
const describeMongo = url ? describe : describe.skip;

describeMongo("MongoTelemetry (live)", () => {
  let admin: MongoClient | null = null;
  let dbName: string;

  beforeAll(async () => {
    admin = new MongoClient(url!);
    await admin.connect();
    dbName = `ca_test_telemetry_${Math.random().toString(36).slice(2, 10)}`;
  });

  afterAll(async () => {
    if (admin) {
      await admin.db(dbName).dropDatabase().catch(() => {});
      await admin.close();
    }
  });

  let tel: MongoTelemetry;
  afterEach(async () => {
    if (tel) await tel.onClose?.();
    if (admin) {
      await admin.db(dbName).collection("agent_registry").deleteMany({});
      await admin.db(dbName).collection("agent_logs").deleteMany({});
    }
  });

  it("onAgentConstructed upserts the agent into agent_registry", async () => {
    tel = new MongoTelemetry({
      url: url!,
      database: dbName,
      agent: {
        name: "agent-construct",
        label: "Constructed",
        registeredBy: "test-host",
      },
    });
    const info: AgentConstructedInfo = {
      source: { type: "git", url: "github.com/o/r" },
      harness: "claude-agent-sdk",
      model: "bedrock/claude-sonnet-4",
    };
    await tel.onAgentConstructed!(info);

    const reg = new AgentRegistry({ url: url!, database: dbName });
    const doc = await reg.get("agent-construct");
    await reg.close();

    expect(doc).not.toBeNull();
    expect(doc!._id).toBe("agent-construct");
    expect(doc!.label).toBe("Constructed");
    // Constructor info overrides whatever the caller passed at telemetry init
    expect(doc!.harness).toBe("claude-agent-sdk");
    expect(doc!.source).toEqual({ type: "git", url: "github.com/o/r" });
    expect(doc!.model).toBe("bedrock/claude-sonnet-4");
    expect(doc!.registeredBy).toBe("test-host");
  });

  it("falls back to constructor-supplied agent.harness/source/model when SDK info is undefined", async () => {
    tel = new MongoTelemetry({
      url: url!,
      database: dbName,
      agent: {
        name: "agent-fallback",
        harness: "gitagent",
        source: { type: "git", url: "github.com/o/fb" },
        model: "openai:gpt-4",
      },
    });
    // Cast undefined-source through — the SDK does call this with the
    // structured source though; this proves the fallback path.
    await tel.onAgentConstructed!({
      source: undefined as unknown as AgentConstructedInfo["source"],
      harness: undefined as unknown as string,
    });

    const reg = new AgentRegistry({ url: url!, database: dbName });
    const doc = await reg.get("agent-fallback");
    await reg.close();

    expect(doc!.harness).toBe("gitagent");
    expect(doc!.source).toEqual({ type: "git", url: "github.com/o/fb" });
    expect(doc!.model).toBe("openai:gpt-4");
  });

  it("onChatStart returns a context with startedAt + message", () => {
    tel = new MongoTelemetry({
      url: url!,
      database: dbName,
      agent: { name: "agent-start", harness: "claude-agent-sdk" },
    });
    const info: ChatStartInfo = {
      sessionIdPromise: Promise.resolve("sess_test"),
      message: "hello there",
    };
    const ctx = tel.onChatStart!(info) as { startedAt: number; message: string };
    expect(ctx.message).toBe("hello there");
    expect(typeof ctx.startedAt).toBe("number");
    expect(ctx.startedAt).toBeLessThanOrEqual(Date.now());
  });

  it("onChatEnd appends a row to agent_logs (success path)", async () => {
    tel = new MongoTelemetry({
      url: url!,
      database: dbName,
      agent: { name: "agent-end", harness: "claude-agent-sdk" },
    });
    const ctx = tel.onChatStart!({
      sessionIdPromise: Promise.resolve("sess_x"),
      message: "what's up?",
    });
    const info: ChatEndInfo = {
      context: ctx,
      sessionId: "sess_x",
      ok: true,
      durationMs: 2222,
      usage: { inputTokens: 100, outputTokens: 25, costUsd: 0.005 },
      reply: "all good",
    };
    await tel.onChatEnd!(info);

    const logs = new AgentLogStore({ url: url!, database: dbName });
    const rows = await logs.list({ agentName: "agent-end" });
    await logs.close();

    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.agentName).toBe("agent-end");
    expect(row.source).toBe("library");
    expect(row.requester).toBe("library");
    expect(row.sessionId).toBe("sess_x");
    expect(row.query).toBe("what's up?");
    expect(row.reply).toBe("all good");
    expect(row.ok).toBe(true);
    expect(row.durationMs).toBe(2222);
    expect(row.inputTokens).toBe(100);
    expect(row.outputTokens).toBe(25);
    expect(row.costUsd).toBe(0.005);
  });

  it("onChatEnd appends with ok=false + error on the failure path", async () => {
    tel = new MongoTelemetry({
      url: url!,
      database: dbName,
      agent: { name: "agent-fail", harness: "claude-agent-sdk" },
    });
    const ctx = tel.onChatStart!({
      sessionIdPromise: Promise.resolve(""),
      message: "doomed",
    });
    await tel.onChatEnd!({
      context: ctx,
      sessionId: "",
      ok: false,
      error: "Network unreachable",
      durationMs: 50,
    });
    const logs = new AgentLogStore({ url: url!, database: dbName });
    const [row] = await logs.list({ agentName: "agent-fail" });
    await logs.close();
    expect(row!.ok).toBe(false);
    expect(row!.error).toBe("Network unreachable");
    expect(row!.reply).toBe("");
    expect(row!.durationMs).toBe(50);
  });

  it("derives durationMs from ctx.startedAt when not supplied by the SDK", async () => {
    tel = new MongoTelemetry({
      url: url!,
      database: dbName,
      agent: { name: "agent-derive", harness: "claude-agent-sdk" },
    });
    const ctx = tel.onChatStart!({
      sessionIdPromise: Promise.resolve("s"),
      message: "m",
    });
    await new Promise((r) => setTimeout(r, 25));
    await tel.onChatEnd!({
      context: ctx,
      sessionId: "s",
      ok: true,
      durationMs: undefined as unknown as number, // simulate undefined
    });
    const logs = new AgentLogStore({ url: url!, database: dbName });
    const [row] = await logs.list({ agentName: "agent-derive" });
    await logs.close();
    expect(row!.durationMs).toBeGreaterThanOrEqual(20);
  });

  it("uses a configurable `source` tag in the log row", async () => {
    tel = new MongoTelemetry({
      url: url!,
      database: dbName,
      agent: { name: "agent-source", harness: "claude-agent-sdk" },
      source: "slack",
    });
    const ctx = tel.onChatStart!({ sessionIdPromise: Promise.resolve("s"), message: "m" });
    await tel.onChatEnd!({ context: ctx, sessionId: "s", ok: true, durationMs: 1 });
    const logs = new AgentLogStore({ url: url!, database: dbName });
    const [row] = await logs.list({ agentName: "agent-source" });
    await logs.close();
    expect(row!.source).toBe("slack");
    // requester only auto-set to "library" when source === "library"
    expect(row!.requester).toBe(null);
  });

  it("invokes onError when the registry write fails (does not throw)", async () => {
    const onError = vi.fn();
    // Point at a database with an invalid name (Mongo rejects names containing
    // null bytes) to force a write error on register().
    tel = new MongoTelemetry({
      url: url!,
      database: "bad name",
      agent: { name: "agent-err", harness: "claude-agent-sdk" },
      onError,
    });
    await tel.onAgentConstructed!({
      source: { type: "git", url: "github.com/o/r" },
      harness: "claude-agent-sdk",
    });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]![1]).toBe("onAgentConstructed");
  });

  it("respects a shared MongoClient — onClose() does NOT close it", async () => {
    const shared = new MongoClient(url!);
    await shared.connect();
    tel = new MongoTelemetry({
      url: url!,
      database: dbName,
      agent: { name: "agent-shared", harness: "claude-agent-sdk" },
      client: shared,
    });
    await tel.onAgentConstructed!({
      source: { type: "git", url: "github.com/o/sh" },
      harness: "claude-agent-sdk",
    });
    await tel.onClose!();
    // Shared client should still be usable.
    const db = shared.db(dbName);
    const doc = await db.collection("agent_registry").findOne({ _id: "agent-shared" });
    expect(doc).not.toBeNull();
    await shared.close();
  });

  it("exposes registryStore + logStore accessors for direct CRUD", () => {
    tel = new MongoTelemetry({
      url: url!,
      database: dbName,
      agent: { name: "agent-x", harness: "claude-agent-sdk" },
    });
    expect(tel.registryStore).toBeInstanceOf(AgentRegistry);
    expect(tel.logStore).toBeInstanceOf(AgentLogStore);
  });
});

// Always-on sanity: constructor doesn't connect eagerly + onError default is a logger.
describe("MongoTelemetry — constructor (offline)", () => {
  it("does not throw with a bogus URL", () => {
    const t = new MongoTelemetry({
      url: "mongodb://nope:27017",
      database: "x",
      agent: { name: "x", harness: "claude-agent-sdk" },
    });
    expect(t).toBeDefined();
  });

  it("exposes the AgentTelemetry interface methods", () => {
    const t = new MongoTelemetry({
      url: "mongodb://nope:27017",
      database: "x",
      agent: { name: "x", harness: "claude-agent-sdk" },
    });
    expect(typeof t.onAgentConstructed).toBe("function");
    expect(typeof t.onChatStart).toBe("function");
    expect(typeof t.onChatEnd).toBe("function");
    expect(typeof t.onClose).toBe("function");
  });
});
