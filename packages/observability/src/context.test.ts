import { describe, it, expect } from "vitest";
import { getConversationId, withConversationId, enterConversation } from "./context.js";

describe("conversation-id context", () => {
  it("returns undefined when no id has been set", () => {
    expect(getConversationId()).toBeUndefined();
  });

  it("binds the id for the duration of withConversationId", async () => {
    let inside: string | undefined;
    await withConversationId("sess-123", async () => {
      inside = getConversationId();
    });
    expect(inside).toBe("sess-123");
    expect(getConversationId()).toBeUndefined();
  });

  it("survives across awaited async boundaries", async () => {
    await withConversationId("sess-abc", async () => {
      await new Promise((res) => setTimeout(res, 5));
      expect(getConversationId()).toBe("sess-abc");
    });
  });

  it("nests correctly — inner shadows outer for the inner block only", async () => {
    await withConversationId("outer", async () => {
      expect(getConversationId()).toBe("outer");
      await withConversationId("inner", async () => {
        expect(getConversationId()).toBe("inner");
      });
      expect(getConversationId()).toBe("outer");
    });
  });

  it("does not leak across sibling tasks", async () => {
    const results = await Promise.all([
      withConversationId("a", async () => {
        await new Promise((res) => setTimeout(res, 3));
        return getConversationId();
      }),
      withConversationId("b", async () => {
        await new Promise((res) => setTimeout(res, 1));
        return getConversationId();
      }),
    ]);
    expect(results).toEqual(["a", "b"]);
  });

  it("enterConversation sets the id imperatively and the disposer clears it", () => {
    const dispose = enterConversation("imperative");
    expect(getConversationId()).toBe("imperative");
    dispose();
    expect(getConversationId()).toBeUndefined();
  });
});
