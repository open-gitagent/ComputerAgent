// Unit tests for the New Relic NerdGraph adapter.
//
// Two surfaces under test:
//   1. `renderNrql` — typed parameter substitution with proper escaping.
//   2. `queryRows` / `queryOne` — NerdGraph HTTP plumbing, retry, errors.
//
// HTTP is mocked via globalThis.fetch so we don't need a real account.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { queryOne, queryRows, renderNrql } from "./new-relic.js";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env["NEW_RELIC_USER_API_KEY"] = "test-user-key";
  process.env["NEW_RELIC_ACCOUNT_ID"] = "1234567";
  process.env["NEW_RELIC_REGION"] = "US";
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

describe("renderNrql — string params", () => {
  it("wraps strings in single quotes", () => {
    expect(renderNrql("agent={a:String}", { a: "router" })).toBe("agent='router'");
  });

  it("doubles embedded single quotes (NRQL escape rule)", () => {
    expect(renderNrql("name={n:String}", { n: "Bob's agent" })).toBe(
      "name='Bob''s agent'",
    );
  });

  it("escapes backslashes", () => {
    expect(renderNrql("path={p:String}", { p: "C:\\tmp" })).toBe(
      "path='C:\\\\tmp'",
    );
  });

  it("throws when the wrong JS type is passed for String", () => {
    expect(() => renderNrql("a={a:String}", { a: 42 })).toThrow(/String param/);
  });
});

describe("renderNrql — numeric params", () => {
  it("formats UInt32 as bare decimal", () => {
    expect(renderNrql("c={c:UInt32}", { c: 7 })).toBe("c=7");
  });

  it("formats Float64 with full precision", () => {
    expect(renderNrql("p={p:Float64}", { p: 0.1234 })).toBe("p=0.1234");
  });

  it("rejects non-integer UInt32", () => {
    expect(() => renderNrql("c={c:UInt32}", { c: 1.5 })).toThrow(/integer expected/);
  });

  it("rejects negative UInt32", () => {
    expect(() => renderNrql("c={c:UInt32}", { c: -1 })).toThrow(/unsigned integer/);
  });

  it("rejects NaN", () => {
    expect(() => renderNrql("p={p:Float64}", { p: NaN })).toThrow(/non-finite/);
  });
});

describe("renderNrql — Timestamp params", () => {
  it("accepts a Date and emits ISO 8601 string", () => {
    const d = new Date("2024-06-01T12:30:00.000Z");
    expect(renderNrql("t={t:Timestamp}", { t: d })).toBe(
      "t='2024-06-01T12:30:00.000Z'",
    );
  });

  it("accepts a number (ms since epoch)", () => {
    const epochMs = new Date("2024-06-01T12:30:00.000Z").getTime();
    expect(renderNrql("t={t:Timestamp}", { t: epochMs })).toBe(
      "t='2024-06-01T12:30:00.000Z'",
    );
  });

  it("accepts an already-formatted string", () => {
    expect(renderNrql("t={t:Timestamp}", { t: "2024-06-01T12:30:00.000Z" })).toBe(
      "t='2024-06-01T12:30:00.000Z'",
    );
  });
});

describe("renderNrql — Array params", () => {
  it("formats Array(String) as parenthesized IN-list", () => {
    expect(
      renderNrql("model IN {m:Array(String)}", { m: ["sonnet-4", "haiku-4"] }),
    ).toBe("model IN ('sonnet-4', 'haiku-4')");
  });

  it("formats Array(UInt32)", () => {
    expect(
      renderNrql("c IN {c:Array(UInt32)}", { c: [1, 2, 3] }),
    ).toBe("c IN (1, 2, 3)");
  });

  it("escapes strings inside an array", () => {
    expect(
      renderNrql("n IN {n:Array(String)}", { n: ["O'Brien"] }),
    ).toBe("n IN ('O''Brien')");
  });
});

describe("renderNrql — error handling", () => {
  it("throws when a referenced param is missing", () => {
    expect(() => renderNrql("a={a:String}", {})).toThrow(/missing NRQL param: a/);
  });

  it("leaves the template alone when no placeholders are present", () => {
    expect(renderNrql("SELECT count(*) FROM Span")).toBe("SELECT count(*) FROM Span");
  });
});

describe("queryRows — HTTP plumbing", () => {
  it("posts NRQL inside a NerdGraph envelope with API-Key header", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: { actor: { account: { nrql: { results: [{ x: 1 }] } } } },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const rows = await queryRows<{ x: number }>(
      "SELECT count(*) AS x FROM Span WHERE service.name = {s:String}",
      { s: "agent" },
    );

    expect(rows).toEqual([{ x: 1 }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.newrelic.com/graphql");
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>)["API-Key"]).toBe("test-user-key");
    const body = JSON.parse(init?.body as string);
    expect(body.variables.accountId).toBe(1234567);
    expect(body.variables.nrql).toContain("service.name = 'agent'");
  });

  it("uses the EU endpoint when NEW_RELIC_REGION=EU", async () => {
    process.env["NEW_RELIC_REGION"] = "EU";
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ data: { actor: { account: { nrql: { results: [] } } } } }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await queryRows("SELECT 1 FROM Span");

    expect(fetchMock.mock.calls[0]![0]).toBe("https://api.eu.newrelic.com/graphql");
  });

  it("retries up to 2 times on HTTP failures", async () => {
    let attempts = 0;
    const fetchMock = vi.fn(async () => {
      attempts++;
      if (attempts < 3) return new Response("boom", { status: 500 });
      return new Response(
        JSON.stringify({ data: { actor: { account: { nrql: { results: [{ ok: true }] } } } } }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const rows = await queryRows<{ ok: boolean }>("SELECT 1 FROM Span");
    expect(rows).toEqual([{ ok: true }]);
    expect(attempts).toBe(3);
  });

  it("surfaces GraphQL errors", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ errors: [{ message: "Invalid NRQL: bad syntax" }] }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(queryRows("SELECT * FROM Nope")).rejects.toThrow(
      /Invalid NRQL: bad syntax/,
    );
  });

  it("rejects when the API key env var is missing", async () => {
    delete process.env["NEW_RELIC_USER_API_KEY"];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 200 })),
    );
    await expect(queryRows("SELECT 1 FROM Span")).rejects.toThrow(
      /NEW_RELIC_USER_API_KEY/,
    );
  });

  it("rejects when the account ID env var is malformed", async () => {
    process.env["NEW_RELIC_ACCOUNT_ID"] = "not-a-number";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 200 })),
    );
    await expect(queryRows("SELECT 1 FROM Span")).rejects.toThrow(
      /positive integer/,
    );
  });
});

describe("queryOne — single-row helper", () => {
  it("returns the first row", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            data: {
              actor: { account: { nrql: { results: [{ id: "a" }, { id: "b" }] } } },
            },
          }),
          { status: 200 },
        ),
      ),
    );
    const row = await queryOne<{ id: string }>("SELECT id FROM Span");
    expect(row).toEqual({ id: "a" });
  });

  it("returns null when results are empty", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ data: { actor: { account: { nrql: { results: [] } } } } }),
          { status: 200 },
        ),
      ),
    );
    const row = await queryOne("SELECT 1 FROM Span");
    expect(row).toBeNull();
  });
});
