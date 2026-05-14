import { describe, expect, it } from "vitest";
import type { SessionStoreEntry } from "@computeragent/protocol";
import { MemorySessionStore } from "@computeragent/harness-server";
import {
  appendAssistantTurn,
  appendUserTurn,
  nextTurnIndex,
  renderPriorContext,
  TurnIndexer,
} from "./session-replay.js";

describe("nextTurnIndex", () => {
  it("returns 0 when there are no prior entries", () => {
    expect(nextTurnIndex([])).toBe(0);
  });
  it("returns max(turnIndex) + 1 across mixed entries", () => {
    const prior: SessionStoreEntry[] = [
      { type: "ca_user", turnIndex: 0, text: "a" } as never,
      { type: "ca_assistant", turnIndex: 1, text: "b" } as never,
      { type: "ca_assistant", turnIndex: 2, text: "c" } as never,
    ];
    expect(nextTurnIndex(prior)).toBe(3);
  });
  it("ignores entries without turnIndex (legacy)", () => {
    const prior: SessionStoreEntry[] = [
      { type: "ca_user", text: "legacy" } as never,
      { type: "ca_assistant", turnIndex: 5, text: "modern" } as never,
    ];
    expect(nextTurnIndex(prior)).toBe(6);
  });
});

describe("TurnIndexer", () => {
  it("issues monotonic indices starting at the given cursor", () => {
    const idx = new TurnIndexer(3);
    expect(idx.next()).toBe(3);
    expect(idx.next()).toBe(4);
    expect(idx.peek()).toBe(5);
    expect(idx.next()).toBe(5);
  });
});

describe("renderPriorContext", () => {
  it("returns null when there are no replay entries", () => {
    expect(renderPriorContext([])).toBeNull();
    expect(renderPriorContext([
      { type: "unrelated", text: "x" } as never,
    ])).toBeNull();
  });

  it("renders user / assistant entries in turnIndex order regardless of insertion order", () => {
    // Write order: assistant first, then user. Expected render order: user → assistant by turnIndex.
    const entries: SessionStoreEntry[] = [
      { type: "ca_assistant", turnIndex: 1, text: "hello" } as never,
      { type: "ca_user", turnIndex: 0, text: "hi" } as never,
    ];
    const rendered = renderPriorContext(entries);
    expect(rendered).toContain("user: hi\nassistant: hello");
  });

  it("ignores non-replay entry types", () => {
    const rendered = renderPriorContext([
      { type: "ca_user", turnIndex: 0, text: "u" } as never,
      { type: "queue-operation", sessionId: "s", content: "noise" } as never,
      { type: "ca_assistant", turnIndex: 1, text: "a" } as never,
    ]);
    expect(rendered).toContain("user: u\nassistant: a");
    expect(rendered).not.toContain("noise");
  });
});

describe("appendUserTurn + appendAssistantTurn via MemorySessionStore", () => {
  it("idempotency: same role+turnIndex+text replays produce the same uuid", async () => {
    const store = new MemorySessionStore();
    await appendUserTurn(store, "s1", "hello", 0);
    await appendUserTurn(store, "s1", "hello", 0);
    expect(await store.size("s1")).toBe(1);
  });

  it("different turnIndex → different uuid → both retained", async () => {
    const store = new MemorySessionStore();
    await appendUserTurn(store, "s1", "hello", 0);
    await appendUserTurn(store, "s1", "hello", 1);
    expect(await store.size("s1")).toBe(2);
  });

  it("appendAssistantTurn skips empty text", async () => {
    const store = new MemorySessionStore();
    await appendAssistantTurn(store, "s1", "", 0);
    expect(await store.size("s1")).toBe(0);
  });

  it("entries carry turnIndex and timestamp", async () => {
    const store = new MemorySessionStore();
    await appendAssistantTurn(store, "s1", "ok", 7);
    const entries = await store.load({ projectKey: "p", sessionId: "s1" });
    expect(entries).toHaveLength(1);
    const e = entries![0] as { turnIndex?: number; timestamp?: string; type?: string; text?: string };
    expect(e.turnIndex).toBe(7);
    expect(typeof e.timestamp).toBe("string");
    expect(e.type).toBe("ca_assistant");
    expect(e.text).toBe("ok");
  });
});
