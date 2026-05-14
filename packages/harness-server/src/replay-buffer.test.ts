import { describe, expect, it } from "vitest";
import { ReplayBuffer } from "./replay-buffer.js";

async function collect<T>(iter: AsyncIterable<T>, n: number): Promise<T[]> {
  const out: T[] = [];
  for await (const v of iter) {
    out.push(v);
    if (out.length >= n) break;
  }
  return out;
}

describe("ReplayBuffer", () => {
  it("assigns monotonic ids starting at 0", () => {
    const b = new ReplayBuffer<string>();
    expect(b.push("a").id).toBe(0);
    expect(b.push("b").id).toBe(1);
    expect(b.push("c").id).toBe(2);
    expect(b.lastEventId).toBe(2);
  });

  it("replays buffered events from since=-1 then tails new events", async () => {
    const b = new ReplayBuffer<string>();
    b.push("a");
    b.push("b");
    const iter = b.iterate({ since: -1 })[Symbol.asyncIterator]();
    expect((await iter.next()).value).toEqual({ id: 0, event: "a" });
    expect((await iter.next()).value).toEqual({ id: 1, event: "b" });

    const pending = iter.next();
    b.push("c");
    expect((await pending).value).toEqual({ id: 2, event: "c" });
  });

  it("replay-from-since skips events with id <= since", async () => {
    const b = new ReplayBuffer<string>();
    b.push("a");
    b.push("b");
    b.push("c");
    const events = await collect(b.iterate({ since: 0 }), 2);
    expect(events).toEqual([
      { id: 1, event: "b" },
      { id: 2, event: "c" },
    ]);
  });

  it("two concurrent iterators each get every event", async () => {
    const b = new ReplayBuffer<string>();
    const a = b.iterate()[Symbol.asyncIterator]();
    const c = b.iterate()[Symbol.asyncIterator]();
    const aNext = a.next();
    const cNext = c.next();
    b.push("x");
    expect((await aNext).value).toEqual({ id: 0, event: "x" });
    expect((await cNext).value).toEqual({ id: 0, event: "x" });
  });

  it("close() drains in-flight iterators and ends them", async () => {
    const b = new ReplayBuffer<string>();
    b.push("a");
    const iter = b.iterate()[Symbol.asyncIterator]();
    expect((await iter.next()).value).toEqual({ id: 0, event: "a" });
    const pending = iter.next();
    b.close();
    expect((await pending).done).toBe(true);
  });

  it("close() during pending wait wakes the waiter with done", async () => {
    const b = new ReplayBuffer<string>();
    const iter = b.iterate()[Symbol.asyncIterator]();
    const pending = iter.next();
    b.close();
    const r = await pending;
    expect(r.done).toBe(true);
  });

  it("trims to maxSize, oldest events evicted", () => {
    const b = new ReplayBuffer<string>(3);
    b.push("a"); b.push("b"); b.push("c"); b.push("d");
    expect(b.lastEventId).toBe(3);
    expect(b.firstRetainedId).toBe(1);
  });

  it("since older than the buffer's tail returns whatever is still retained", async () => {
    const b = new ReplayBuffer<string>(2);
    b.push("a"); b.push("b"); b.push("c");      // ring now has [b(1), c(2)]
    const events = await collect(b.iterate({ since: -1 }), 2);
    expect(events).toEqual([
      { id: 1, event: "b" },
      { id: 2, event: "c" },
    ]);
  });

  it("after close, push still increments id but does not retain", () => {
    const b = new ReplayBuffer<string>();
    b.push("a");
    b.close();
    expect(b.push("ignored").id).toBe(1);
    expect(b.lastEventId).toBe(1);
  });
});
