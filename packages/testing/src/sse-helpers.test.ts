import { describe, expect, it } from "vitest";
import { parseSseChunk } from "./sse-helpers.js";

describe("parseSseChunk", () => {
  it("parses a single complete event", () => {
    const buf = `event: sdk_message\nid: 1\ndata: {"kind":"sdk_message","payload":{}}\n\n`;
    const { events, remainder } = parseSseChunk(buf);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ kind: "sdk_message", id: "1", data: { kind: "sdk_message", payload: {} } });
    expect(remainder).toBe("");
  });

  it("returns trailing partial as remainder", () => {
    const buf = `event: a\ndata: 1\n\nevent: b\ndata: 2`;
    const { events, remainder } = parseSseChunk(buf);
    expect(events).toHaveLength(1);
    expect(remainder).toBe("event: b\ndata: 2");
  });

  it("handles multiline data fields", () => {
    const buf = `event: msg\ndata: {"a":\ndata: 1}\n\n`;
    const { events } = parseSseChunk(buf);
    expect(events[0]?.data).toEqual({ a: 1 });
  });

  it("skips empty blocks", () => {
    const buf = `\n\nevent: x\ndata: 1\n\n\n\n`;
    const { events } = parseSseChunk(buf);
    expect(events).toHaveLength(1);
  });
});
