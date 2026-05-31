/**
 * Hono-level integration tests for `createAgentOSApp` CRUD routes:
 *   GET    /agentos/api/agents               (union of in-memory + registry)
 *   GET    /agentos/api/agents/by-source     (lookup by canonical URL)
 *   POST   /agentos/api/agents/register      (upsert into agent_registry)
 *   PATCH  /agentos/api/agents/:name         (update — not in-memory)
 *   DELETE /agentos/api/agents/:name         (remove — not in-memory)
 *
 * Drives the app via `app.fetch(new Request(...))` — no real HTTP server.
 * Live-Mongo gated on MONGO_URL; unique DB per run for isolation.
 *
 * What we don't cover here: the loopback `caBase` fetch in GET /agents (it
 * decorates the response with active-sandbox state). The handler swallows
 * fetch errors as best-effort, so the test paths still return clean shapes
 * without that fetch ever succeeding.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { MongoClient } from "mongodb";
import { createAgentOSApp, type AgentDef } from "./agentos-api.ts";
import { AgentLogStore } from "./agent-log-store.ts";

const url = process.env.MONGO_URL;
const describeMongo = url ? describe : describe.skip;

describeMongo("agentos-api CRUD (live)", () => {
  let admin: MongoClient;
  let dbName: string;
  let logStore: AgentLogStore;
  let app: ReturnType<typeof createAgentOSApp>;

  const IN_MEMORY_AGENTS: readonly AgentDef[] = [
    {
      name: "gitagent",
      label: "GitAgent",
      harness: "gitagent",
      source: "github.com/open-gitagent/opengap",
    },
    {
      name: "claude-code",
      label: "Claude Code",
      harness: "claude-agent-sdk",
      source: "github.com/anthropics/claude-code",
    },
  ];

  beforeAll(async () => {
    admin = new MongoClient(url!);
    await admin.connect();
    dbName = `ca_test_agentosapi_${Math.random().toString(36).slice(2, 10)}`;
    logStore = new AgentLogStore(url!, dbName);
    app = createAgentOSApp({
      mongoUrl: url!,
      mongoDb: dbName,
      agents: IN_MEMORY_AGENTS,
      logStore,
      // No scheduleStore — schedule endpoints aren't under test here.
    });
  });

  afterAll(async () => {
    await logStore.close?.().catch(() => {});
    await admin.db(dbName).dropDatabase().catch(() => {});
    await admin.close();
  });

  afterEach(async () => {
    await admin.db(dbName).collection("agent_registry").deleteMany({});
  });

  const req = (method: string, path: string, body?: unknown) =>
    app.fetch(
      new Request(`http://test.local${path}`, {
        method,
        headers: body !== undefined ? { "content-type": "application/json" } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      }),
    );

  describe("POST /agents/register", () => {
    it("400s when name is missing", async () => {
      const r = await req("POST", "/agentos/api/agents/register", { label: "x" });
      expect(r.status).toBe(400);
      const j = (await r.json()) as { error: { code: string } };
      expect(j.error.code).toBe("BAD_REQUEST");
    });

    it("upserts a new agent into agent_registry", async () => {
      const r = await req("POST", "/agentos/api/agents/register", {
        name: "library-agent",
        label: "Library Agent",
        harness: "claude-agent-sdk",
        source: { type: "git", url: "github.com/o/lib" },
        model: "bedrock/claude-sonnet-4",
        registeredBy: "test-host",
      });
      expect(r.status).toBe(200);
      const doc = await admin.db(dbName).collection("agent_registry").findOne({ _id: "library-agent" });
      expect(doc).not.toBeNull();
      expect(doc!.label).toBe("Library Agent");
      expect(doc!.harness).toBe("claude-agent-sdk");
      expect(doc!.source).toEqual({ type: "git", url: "github.com/o/lib" });
      expect(doc!.model).toBe("bedrock/claude-sonnet-4");
      expect(doc!.registeredBy).toBe("test-host");
      expect(doc!.registeredAt).toBeInstanceOf(Date);
      expect(doc!.updatedAt).toBeInstanceOf(Date);
    });

    it("is idempotent — re-registering preserves registeredAt", async () => {
      await req("POST", "/agentos/api/agents/register", {
        name: "idempotent-agent",
        harness: "gitagent",
        source: "github.com/o/idemp",
      });
      const firstDoc = await admin.db(dbName).collection("agent_registry").findOne({ _id: "idempotent-agent" });
      const firstAt = firstDoc!.registeredAt!.getTime();

      await new Promise((r) => setTimeout(r, 10));
      await req("POST", "/agentos/api/agents/register", {
        name: "idempotent-agent",
        harness: "gitagent",
        source: "github.com/o/idemp",
        label: "Now Labeled",
      });
      const secondDoc = await admin.db(dbName).collection("agent_registry").findOne({ _id: "idempotent-agent" });
      expect(secondDoc!.registeredAt!.getTime()).toBe(firstAt);
      expect(secondDoc!.label).toBe("Now Labeled");
    });
  });

  describe("PATCH /agents/:name", () => {
    it("409s when the target is an in-memory agent", async () => {
      const r = await req("PATCH", "/agentos/api/agents/gitagent", { label: "no" });
      expect(r.status).toBe(409);
      const j = (await r.json()) as { error: { code: string } };
      expect(j.error.code).toBe("IN_MEMORY_AGENT");
    });

    it("404s when the registry has no such agent", async () => {
      const r = await req("PATCH", "/agentos/api/agents/never-registered", { label: "nope" });
      expect(r.status).toBe(404);
    });

    it("updates label/harness/source/model in the registry", async () => {
      await req("POST", "/agentos/api/agents/register", {
        name: "patchable",
        harness: "gitagent",
        source: "github.com/o/p",
        label: "before",
      });
      const r = await req("PATCH", "/agentos/api/agents/patchable", {
        label: "after",
        model: "claude-haiku-4-5",
      });
      expect(r.status).toBe(200);
      const doc = await admin.db(dbName).collection("agent_registry").findOne({ _id: "patchable" });
      expect(doc!.label).toBe("after");
      expect(doc!.model).toBe("claude-haiku-4-5");
      expect(doc!.harness).toBe("gitagent"); // untouched
    });
  });

  describe("DELETE /agents/:name", () => {
    it("409s when the target is an in-memory agent", async () => {
      const r = await req("DELETE", "/agentos/api/agents/gitagent");
      expect(r.status).toBe(409);
    });

    it("404s when the registry has no such agent", async () => {
      const r = await req("DELETE", "/agentos/api/agents/missing-from-registry");
      expect(r.status).toBe(404);
    });

    it("removes a registry agent", async () => {
      await req("POST", "/agentos/api/agents/register", {
        name: "doomed",
        harness: "gitagent",
        source: "github.com/o/d",
      });
      const r = await req("DELETE", "/agentos/api/agents/doomed");
      expect(r.status).toBe(200);
      const doc = await admin.db(dbName).collection("agent_registry").findOne({ _id: "doomed" });
      expect(doc).toBeNull();
    });
  });

  describe("GET /agents/by-source", () => {
    it("400s when `url` query param is missing", async () => {
      const r = await req("GET", "/agentos/api/agents/by-source");
      expect(r.status).toBe(400);
    });

    it("finds an in-memory agent whose source string matches", async () => {
      const r = await req(
        "GET",
        `/agentos/api/agents/by-source?url=${encodeURIComponent("github.com/open-gitagent/opengap")}`,
      );
      expect(r.status).toBe(200);
      const j = (await r.json()) as { matches: Array<{ name: string }> };
      expect(j.matches.map((m) => m.name)).toContain("gitagent");
    });

    it("finds a registry agent whose structured git source matches", async () => {
      await req("POST", "/agentos/api/agents/register", {
        name: "by-src-registry",
        harness: "claude-agent-sdk",
        source: { type: "git", url: "github.com/o/by-src" },
      });
      const r = await req(
        "GET",
        `/agentos/api/agents/by-source?url=${encodeURIComponent("github.com/o/by-src")}`,
      );
      expect(r.status).toBe(200);
      const j = (await r.json()) as { matches: Array<{ name: string }> };
      expect(j.matches.map((m) => m.name)).toContain("by-src-registry");
    });

    it("returns BOTH when the same URL is registered under two names (dedup detection)", async () => {
      await req("POST", "/agentos/api/agents/register", {
        name: "dev-worker",
        harness: "claude-agent-sdk",
        source: { type: "git", url: "github.com/o/shared" },
      });
      await req("POST", "/agentos/api/agents/register", {
        name: "prod-worker",
        harness: "claude-agent-sdk",
        source: { type: "git", url: "github.com/o/shared" },
      });
      const r = await req(
        "GET",
        `/agentos/api/agents/by-source?url=${encodeURIComponent("github.com/o/shared")}`,
      );
      const j = (await r.json()) as { matches: Array<{ name: string }> };
      const names = j.matches.map((m) => m.name).sort();
      expect(names).toEqual(["dev-worker", "prod-worker"]);
    });

    it("returns an empty match list (200) when nothing matches", async () => {
      const r = await req(
        "GET",
        `/agentos/api/agents/by-source?url=${encodeURIComponent("github.com/no/match")}`,
      );
      expect(r.status).toBe(200);
      const j = (await r.json()) as { matches: unknown[] };
      expect(j.matches).toEqual([]);
    });
  });

  describe("GET /agents (union)", () => {
    it("returns just the in-memory agents when the registry is empty", async () => {
      const r = await req("GET", "/agentos/api/agents");
      expect(r.status).toBe(200);
      const j = (await r.json()) as { agents: Array<{ name: string; origin: string }> };
      const inMem = j.agents.filter((a) => a.origin === "in-memory").map((a) => a.name).sort();
      expect(inMem).toEqual(["claude-code", "gitagent"]);
      expect(j.agents.filter((a) => a.origin === "registry")).toHaveLength(0);
    });

    it("unions in-memory + registry agents and tags origin correctly", async () => {
      await req("POST", "/agentos/api/agents/register", {
        name: "registry-only",
        harness: "claude-agent-sdk",
        source: { type: "git", url: "github.com/o/ro" },
      });
      const r = await req("GET", "/agentos/api/agents");
      const j = (await r.json()) as { agents: Array<{ name: string; origin: string }> };
      const reg = j.agents.find((a) => a.name === "registry-only");
      expect(reg).toBeDefined();
      expect(reg!.origin).toBe("registry");
      const inMem = j.agents.find((a) => a.name === "gitagent");
      expect(inMem!.origin).toBe("in-memory");
    });

    it("in-memory wins on name collision (registry row is hidden)", async () => {
      // Register a row that shadows an in-memory name.
      await req("POST", "/agentos/api/agents/register", {
        name: "gitagent",
        harness: "claude-agent-sdk", // bogus — different harness, would-be wrong
        source: "github.com/wrong/wrong",
        registeredBy: "should-not-win",
      });
      const r = await req("GET", "/agentos/api/agents");
      const j = (await r.json()) as { agents: Array<{ name: string; origin: string; harness: string }> };
      const all = j.agents.filter((a) => a.name === "gitagent");
      expect(all).toHaveLength(1);
      expect(all[0]!.origin).toBe("in-memory");
      expect(all[0]!.harness).toBe("gitagent"); // server-configured one wins
    });
  });
});

// Always-on sanity test: the factory builds an app without touching Mongo.
describe("createAgentOSApp — factory (offline)", () => {
  it("returns a Hono app exposing /agentos/api/health", async () => {
    const log = new AgentLogStore("mongodb://nope:27017", "x");
    const app = createAgentOSApp({
      mongoUrl: "mongodb://nope:27017",
      mongoDb: "x",
      agents: [],
      logStore: log,
    });
    const r = await app.fetch(new Request("http://test.local/agentos/api/health"));
    expect(r.status).toBe(200);
    const j = (await r.json()) as { ok: boolean; agents: string[] };
    expect(j.ok).toBe(true);
    expect(j.agents).toEqual([]);
    await log.close?.().catch(() => {});
  });
});
