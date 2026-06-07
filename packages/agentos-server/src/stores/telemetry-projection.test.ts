// Unit test for the telemetry projection. Mocks `../mongo.js` with an in-memory
// fake of the collections (no real Mongo), so the real `projectEvent` and
// `agentLogStore` run against it. Asserts the 5-collection projection matches
// the shapes the dashboard reads + that event_id-keyed writes are idempotent.

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  function clone(v: any): any {
    if (v instanceof Date) return new Date(v.getTime());
    if (Array.isArray(v)) return v.map(clone);
    if (v && typeof v === "object") {
      const o: any = {};
      for (const k of Object.keys(v)) o[k] = clone(v[k]);
      return o;
    }
    return v;
  }

  class FakeCollection {
    docs = new Map<string, any>();

    async findOne(filter: any) {
      if (filter && filter._id != null) return this.docs.get(filter._id) ?? null;
      for (const d of this.docs.values()) {
        if (Object.entries(filter ?? {}).every(([k, val]) => d[k] === val)) return d;
      }
      return null;
    }

    async insertOne(doc: any) {
      this.docs.set(doc._id, clone(doc));
      return { insertedId: doc._id };
    }

    async updateOne(filter: any, update: any, opts: any = {}) {
      const id = filter._id;
      let doc = this.docs.get(id);
      let upsertedCount = 0;
      if (!doc) {
        if (!opts.upsert) return { upsertedCount: 0, matchedCount: 0, modifiedCount: 0 };
        doc = {};
        if (update.$setOnInsert) Object.assign(doc, clone(update.$setOnInsert));
        if (doc._id == null && id != null) doc._id = id;
        this.docs.set(doc._id, doc);
        upsertedCount = 1;
      }
      if (update.$set) Object.assign(doc, clone(update.$set));
      if (update.$push) {
        for (const [k, v] of Object.entries(update.$push)) {
          if (!Array.isArray(doc[k])) doc[k] = [];
          doc[k].push(clone(v));
        }
      }
      return { upsertedCount, matchedCount: 1, modifiedCount: 1 };
    }

    async countDocuments(filter: any = {}) {
      let n = 0;
      for (const d of this.docs.values()) {
        if (Object.entries(filter).every(([k, val]) => d[k] === val)) n++;
      }
      return n;
    }
  }

  const colls = new Map<string, FakeCollection>();
  const getColl = (name: string) => {
    if (!colls.has(name)) colls.set(name, new FakeCollection());
    return colls.get(name)!;
  };
  const fakeDb = { collection: (name: string) => getColl(name) };
  return { colls, getColl, fakeDb };
});

vi.mock("../mongo.js", () => ({
  getDb: async () => h.fakeDb,
  registryColl: async () => h.getColl("agent_registry"),
  sessionsColl: async () => h.getColl("sessions"),
  chatSessionsColl: async () => h.getColl("chat_sessions"),
  messagesColl: async () => h.getColl("agent_messages"),
}));

import { projectEvent, type IngestEvent } from "./telemetry-projection.js";

function ev(kind: string, payload: Record<string, unknown>, overrides: Partial<IngestEvent> = {}): IngestEvent {
  return {
    event_id: overrides.event_id ?? `ev_${kind}_${Math.random().toString(36).slice(2)}`,
    kind,
    session_id: "sess1",
    timestamp: "2026-06-04T10:00:00.000Z",
    agent_name: "bot-A",
    agent_description: "desc",
    host: "pod-1",
    payload,
    ...overrides,
  };
}

const docsOf = (name: string) => [...h.getColl(name).docs.values()];

beforeEach(() => {
  for (const c of h.colls.values()) c.docs.clear();
});

describe("projectEvent — full run", () => {
  it("projects a session into all five collections with the right shapes", async () => {
    await projectEvent(
      ev("session_started", {
        harness_mode: true,
        prompt: "hello",
        model: "anthropic:claude-x",
        system_prompt: "be nice",
        allowed_tools: ["Read"],
      }),
    );
    await projectEvent(ev("user_message", { text: "hello again" }));
    await projectEvent(ev("tool_use", { tool_name: "Read", tool_input: { path: "x" } }));
    await projectEvent(ev("assistant_message", { text: "hi there" }));
    await projectEvent(
      ev("session_ended", {
        is_error: false,
        result: "final answer",
        duration_ms: 1200,
        total_cost_usd: 0.02,
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
    );

    // agent_registry — library source (harness_mode), prefix-stripped model.
    const reg = docsOf("agent_registry");
    expect(reg).toHaveLength(1);
    // Registry is ObjectId-keyed; `name` is the unique business key.
    expect(reg[0].name).toBe("bot-A");
    expect(reg[0].harness).toBe("claude-agent-sdk");
    expect(reg[0].source.type).toBe("library");
    expect(reg[0].model).toBe("claude-x");
    expect(reg[0].registeredBy).toBe("pod-1");

    // sessions — seeded prompt + the two message entries (tool_use excluded).
    const sessions = docsOf("sessions");
    expect(sessions).toHaveLength(1);
    const s = sessions[0];
    expect(s._id).toBe("sess1");
    expect(s.agentName).toBe("bot-A");
    expect(s.meta.prompt).toBe("hello");
    expect(s.entries.map((e: any) => [e.type, e.text])).toEqual([
      ["user", "hello"],
      ["user", "hello again"],
      ["assistant", "hi there"],
    ]);
    expect(s.ok).toBe(true);
    expect(s.durationMs).toBe(1200);
    expect(s.costUsd).toBe(0.02);
    expect(s.endedAt).toBeInstanceOf(Date);

    // chat_sessions — the canonical list row.
    const chat = docsOf("chat_sessions");
    expect(chat).toHaveLength(1);
    expect(chat[0]).toMatchObject({ _id: "sess1", agent: "bot-A" });
    expect(chat[0].lastMessageAt).toBeInstanceOf(Date);

    // agent_messages — one per non-rollup event (3), keyed on msg_<event_id>.
    const msgs = docsOf("agent_messages");
    expect(msgs.map((m: any) => m.kind).sort()).toEqual([
      "assistant_message",
      "tool_use",
      "user_message",
    ]);
    expect(msgs.every((m: any) => m._id.startsWith("msg_"))).toBe(true);

    // agent_logs — one rollup, both bot+agentName, query from meta.prompt.
    const logs = docsOf("agent_logs");
    expect(logs).toHaveLength(1);
    const log = logs[0];
    expect(log._id.startsWith("log_")).toBe(true);
    expect(log.bot).toBe("bot-A");
    expect(log.agentName).toBe("bot-A");
    expect(log.query).toBe("hello");
    expect(log.reply).toBe("final answer");
    expect(log.ok).toBe(true);
    expect(log.durationMs).toBe(1200);
    expect(log.inputTokens).toBe(10);
    expect(log.outputTokens).toBe(5);
    expect(log.costUsd).toBe(0.02);
  });

  it("builds an inline source when harness_mode is absent", async () => {
    await projectEvent(
      ev("session_started", {
        prompt: "q",
        model: "claude-y",
        system_prompt: "SP",
        allowed_tools: ["Read", "Grep"],
      }),
    );
    const reg = docsOf("agent_registry")[0];
    expect(reg.source.type).toBe("inline");
    expect(reg.source.files["agent.yaml"]).toContain("name:");
    expect(reg.source.files["CLAUDE.md"]).toBe("SP");
  });
});

describe("projectEvent — idempotency", () => {
  it("re-projecting the same event_id does not duplicate messages or logs", async () => {
    const tool = ev("tool_use", { tool_name: "Read" }, { event_id: "fixed-1" });
    const ended = ev(
      "session_ended",
      { is_error: false, result: "r", duration_ms: 1 },
      { event_id: "fixed-2" },
    );

    await projectEvent(tool);
    await projectEvent(tool); // replay
    await projectEvent(ended);
    await projectEvent(ended); // replay

    expect(docsOf("agent_messages")).toHaveLength(1);
    expect(docsOf("agent_messages")[0]._id).toBe("msg_fixed-1");
    expect(docsOf("agent_logs")).toHaveLength(1);
    expect(docsOf("agent_logs")[0]._id).toBe("log_fixed-2");
  });

  it("session_ended/messages before session_started do NOT stub the doc (no transcript loss)", async () => {
    const sid = "ca_outoforder_1";
    // Simulate a dropped/reordered start: an assistant message and the close
    // arrive first, then session_started lands late.
    await projectEvent(ev("assistant_message", { text: "early reply" }, { session_id: sid, event_id: "ooo-a" }));
    await projectEvent(ev("session_ended", { is_error: false, result: "r", duration_ms: 5 }, { session_id: sid, event_id: "ooo-e" }));
    // No stub should exist yet — only session_started may create the doc.
    expect(docsOf("sessions")).toHaveLength(0);

    await projectEvent(ev("session_started", { harness_mode: true, prompt: "hello", model: "m" }, { session_id: sid, event_id: "ooo-s" }));
    const s = docsOf("sessions")[0];
    expect(s).toBeTruthy();
    // The late start owns creation → meta.prompt, createdAt, and the seeded
    // turn-1 entry all survive (would be lost if an earlier upsert had stubbed).
    expect(s.meta?.prompt).toBe("hello");
    expect(s.createdAt).toBeInstanceOf(Date);
    expect(s.entries.filter((e: any) => e.type === "user")).toHaveLength(1);
    // agent_messages still captured the early assistant event independently.
    expect(docsOf("agent_messages").some((m: any) => m._id === "msg_ooo-a")).toBe(true);
  });

  it("seeds the prompt entry only once across repeated session_started", async () => {
    const started = ev("session_started", { prompt: "hello", model: "m" }, { event_id: "s1" });
    await projectEvent(started);
    await projectEvent(started); // replay — must not re-seed
    const s = docsOf("sessions")[0];
    expect(s.entries.filter((e: any) => e.type === "user")).toHaveLength(1);
  });
});

describe("projectEvent — robustness", () => {
  it("skips empty-text message entries", async () => {
    await projectEvent(ev("session_started", { prompt: "", model: "m" }));
    await projectEvent(ev("assistant_message", { text: "" }));
    const s = docsOf("sessions")[0];
    // empty prompt → no seed; empty assistant text → not appended
    expect(s.entries).toHaveLength(0);
  });
});
