// AgentDef + dynamic registry helpers.
//
// The registry is now the source of truth — there's no in-memory list.
// Library-mode SDK consumers can register agents via
// POST /agentos/api/agents/register (or directly via MongoTelemetry on the
// agent_registry collection); the dashboard CRUDs the same rows.
//
// Secrets (ANTHROPIC_API_KEY, GITHUB_TOKEN, etc) stay in the server's env and
// are stitched in at sandbox-create time by `defaultEnvsFor()`. This means
// the registry can be world-readable without leaking provider keys.

import { IdentitySource, type IdentitySource as IdentitySourceT } from "@open-gitagent/protocol";
import { registryColl, type RegistryDoc } from "./mongo.js";

export interface AgentDef {
  name: string;
  label: string;
  harness: string;
  source: string;
  model?: string;
  envs?: Record<string, string>;
  gitToken?: string;
}

// deepagents runs one-shot via /run; everything else gets a warm sandbox.
export function sandboxCapable(harness: string): boolean {
  return harness !== "deepagents";
}

/** Envs the harness needs for a given harness type, sourced from server env. */
export function defaultEnvsFor(harness: string): Record<string, string> {
  if (harness === "claude-agent-sdk" || harness === "claude-code") {
    const key = process.env["ANTHROPIC_API_KEY"];
    if (!key) throw new HttpError(503, "ANTHROPIC_API_KEY not configured on the server");
    return { ANTHROPIC_API_KEY: key };
  }
  // Other harnesses can be added here as they're needed. For now we never
  // throw on unknown harness — caller may have set envs explicitly via the
  // registry doc.
  return {};
}

/**
 * Lookup an agent by name in the Mongo registry. The dashboard creates rows
 * via POST /agents/register; library-mode SDKs write directly via the
 * MongoTelemetry hook. Either way the row schema is the same.
 */
export async function resolveAgent(name: string): Promise<AgentDef | undefined> {
  try {
    const doc = await (await registryColl()).findOne({ _id: name });
    if (!doc) return undefined;
    return registryDocToAgentDef(doc);
  } catch {
    return undefined;
  }
}

export function registryDocToAgentDef(doc: RegistryDoc): AgentDef {
  const srcStr = typeof doc.source === "string"
    ? doc.source
    : (doc.source as { url?: string; path?: string } | null)?.url
      ?? (doc.source as { path?: string } | null)?.path
      ?? "";
  return {
    name: doc._id,
    label: doc.label ?? doc._id,
    harness: doc.harness ?? "claude-agent-sdk",
    source: srcStr,
    ...(doc.model ? { model: doc.model } : {}),
  };
}

/**
 * Normalize a stored `source` field (string | IdentitySource | undefined) into a
 * `{source, sourceUrl}` pair for the dashboard. URL becomes the canonical
 * de-dup key across agents that were registered with the same git repo.
 */
export function normalizeSource(raw: unknown): { source: IdentitySourceT | string; sourceUrl: string | null } {
  if (raw && typeof raw === "object") {
    const parsed = IdentitySource.safeParse(raw);
    if (parsed.success) {
      const s = parsed.data;
      if (s.type === "git") return { source: s, sourceUrl: s.url };
      if (s.type === "local") return { source: s, sourceUrl: s.path };
      return { source: s, sourceUrl: "inline" };
    }
  }
  const str = typeof raw === "string" ? raw : "";
  return { source: str, sourceUrl: str || null };
}

/** Build the POST /sandboxes body the harness expects. Mirrors the contract
 *  from examples/slack-bot.ts:sandboxBodyForBot so Slack and the dashboard
 *  create identically-configured sandboxes. */
export function sandboxBodyFor(agent: AgentDef, sessionId: string): Record<string, unknown> {
  const envs = { ...defaultEnvsFor(agent.harness), ...(agent.envs ?? {}) };
  const body: Record<string, unknown> = {
    source: agent.source,
    harness: agent.harness,
    // runtime omitted — harness picks its defaultRuntime (local on Mac dev,
    // bwrap on Linux when available). Override via AGENTOS_RUNTIME env if you
    // need a specific one.
    ...(process.env["AGENTOS_RUNTIME"] ? { runtime: process.env["AGENTOS_RUNTIME"] } : {}),
    options: { permissionMode: "bypassPermissions", settingSources: ["project"] },
    sessionId,
    sessionStore: { kind: "mongo" },
    autoSave: {
      stateStore: { kind: "s3", options: { prefix: `agentos/${agent.name}/` } },
    },
    envs,
    idleTtlMs: 30 * 60_000,
    ttlMs: 4 * 60 * 60_000,
  };
  if (agent.model) body.model = agent.model;
  if (agent.gitToken) body.gitToken = agent.gitToken;
  return body;
}

/** Build the POST /run body for one-shot runs. */
export function runBodyFor(agent: AgentDef, message: string): Record<string, unknown> {
  const envs = { ...defaultEnvsFor(agent.harness), ...(agent.envs ?? {}) };
  const body: Record<string, unknown> = {
    source: agent.source,
    harness: agent.harness,
    // runtime omitted — harness picks its defaultRuntime (local on Mac dev,
    // bwrap on Linux when available). Override via AGENTOS_RUNTIME env if you
    // need a specific one.
    ...(process.env["AGENTOS_RUNTIME"] ? { runtime: process.env["AGENTOS_RUNTIME"] } : {}),
    options: { permissionMode: "bypassPermissions", settingSources: ["project"] },
    envs,
    message,
  };
  if (agent.model) body.model = agent.model;
  if (agent.gitToken) body.gitToken = agent.gitToken;
  return body;
}

export class HttpError extends Error {
  override readonly name = "HttpError";
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** Optional first-boot seed: insert a default `claude-code` registry row if
 * AGENTOS_SEED_DEFAULT=1 and the registry is empty. Useful for fresh local DBs. */
export async function seedDefaultAgentIfRequested(): Promise<void> {
  if (process.env["AGENTOS_SEED_DEFAULT"] !== "1") return;
  const coll = await registryColl();
  const count = await coll.estimatedDocumentCount();
  if (count > 0) return;
  const now = new Date();
  await coll.updateOne(
    { _id: "claude-code" },
    {
      $setOnInsert: {
        _id: "claude-code",
        label: "Claude Code",
        harness: "claude-agent-sdk",
        source: process.env["AGENTOS_DEFAULT_SOURCE"] ?? "github.com/shreyas-lyzr/general-agent",
        model: process.env["AGENTOS_DEFAULT_MODEL"] ?? "claude-sonnet-4-6",
        registeredAt: now,
        updatedAt: now,
        lastSeen: now,
        registeredBy: "boot-seed",
      },
    },
    { upsert: true },
  );
  console.log("[agentos] seeded default claude-code agent");
}
