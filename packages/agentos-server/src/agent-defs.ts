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

import { ObjectId } from "mongodb";
import { IdentitySource, type IdentitySource as IdentitySourceT } from "@open-gitagent/protocol";
import { agentPoliciesColl, registryColl, type RegistryDoc } from "./mongo.js";

export interface AgentDef {
  /** Surrogate key — the registry doc's ObjectId, stringified. The public
   *  API + frontend address agents by this. */
  id: string;
  name: string;
  label: string;
  harness: string;
  /** Either a string (git URL / local path) or an inline IdentitySource the
   * harness can clone into a workdir (e.g. one written by the Python SDK's
   * `AgentRegistrySink` with `files: {agent.yaml, CLAUDE.md, ...}`). */
  source: string | IdentitySourceT;
  model?: string;
  envs?: Record<string, string>;
  gitToken?: string;
}

/** True when the source can actually be cloned/loaded by the harness — used
 *  by `chat-sandbox` and `/run` to refuse cleanly for unresolvable sources. */
export function hasResolvableSource(source: AgentDef["source"]): boolean {
  if (typeof source === "string") return source.trim().length > 0;
  if (source && typeof source === "object") {
    if (source.type === "git" && source.url) return true;
    if (source.type === "local" && source.path) return true;
    if (source.type === "inline") {
      // Inline is resolvable iff it ships agent.yaml (or any non-empty files
      // map) — manifest alone is not enough to spin up a sandbox.
      const files = (source as { files?: Record<string, unknown> }).files;
      return !!(files && Object.keys(files).length > 0);
    }
  }
  return false;
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
 * Lookup an agent by NAME in the Mongo registry. Used by the internal
 * name-based callers (the Python/library telemetry ingest, the boot seed).
 * The public API resolves by id via `resolveAgentById`.
 */
export async function resolveAgent(name: string): Promise<AgentDef | undefined> {
  try {
    const doc = await (await registryColl()).findOne({ name });
    if (!doc) return undefined;
    return registryDocToAgentDef(doc);
  } catch {
    return undefined;
  }
}

/**
 * Lookup an agent by its registry ObjectId (the public identifier carried in
 * `/agents/:id` routes and `agentId` params). Returns undefined for a
 * malformed id or a missing row so callers can 404 cleanly.
 */
export async function resolveAgentById(id: string): Promise<AgentDef | undefined> {
  if (!ObjectId.isValid(id)) return undefined;
  try {
    const doc = await (await registryColl()).findOne({ _id: new ObjectId(id) });
    if (!doc) return undefined;
    return registryDocToAgentDef(doc);
  } catch {
    return undefined;
  }
}

export function registryDocToAgentDef(doc: RegistryDoc): AgentDef {
  // The registry's `source` field can be:
  //   1. A plain string (legacy git URL / local path), or
  //   2. An IdentitySource object: {type: "git", url}, {type: "local", path},
  //      or {type: "inline", manifest, files: {...}}.
  // For (2) with `git` or `local` we surface the URL/path as a string so
  // existing callers (sandboxBodyFor, the dashboard) keep working. For
  // `inline` we pass the FULL object through so the harness's inline loader
  // gets `files` intact and can spin up a sandbox.
  let resolvedSource: AgentDef["source"];
  if (typeof doc.source === "string") {
    resolvedSource = doc.source;
  } else if (doc.source && typeof doc.source === "object") {
    const s = doc.source as {
      type?: string;
      url?: string;
      path?: string;
      manifest?: unknown;
      files?: Record<string, unknown>;
    };
    if (s.type === "git" && s.url) {
      resolvedSource = s.url;
    } else if (s.type === "local" && s.path) {
      resolvedSource = s.path;
    } else if (s.type === "inline") {
      // Pass the IdentitySource through verbatim. sandboxBodyFor will forward
      // `files` to the harness; the inline loader materializes them in the
      // sandbox workdir before the engine starts.
      resolvedSource = doc.source as IdentitySourceT;
    } else {
      resolvedSource = (s.url ?? s.path ?? "") as string;
    }
  } else {
    resolvedSource = "";
  }

  return {
    id: doc._id.toString(),
    name: doc.name,
    label: doc.label ?? doc.name,
    harness: doc.harness ?? "claude-agent-sdk",
    source: resolvedSource,
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

/**
 * Build the SRS policy config for an agent if it has a bound RAI policy.
 *
 * Returns null when SRS isn't configured (`SRS_BASE_URL` unset) or the agent
 * has no binding in `agent_policies`. The harness's SrsPolicyDecider uses
 * `endpoint` to reach SRS per tool call — `SRS_BASE_URL` is reachable from the
 * harness container too (host.docker.internal:8500 on Docker Desktop), so the
 * same value works for both agentos and the spawned harness.
 */
export async function srsPolicyForAgent(agentName: string): Promise<Record<string, unknown> | null> {
  const endpoint = process.env["SRS_BASE_URL"];
  if (!endpoint) return null;
  const doc = await (await agentPoliciesColl()).findOne({ agentName });
  if (!doc?.policyId) return null;
  return {
    kind: "srs",
    endpoint,
    apiKey: process.env["SRS_API_KEY"] ?? "",
    policyId: doc.policyId,
    principalId: agentName,
  };
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
    { name: "claude-code" },
    {
      // No `_id` here — Mongo mints the surrogate ObjectId on insert.
      $setOnInsert: {
        name: "claude-code",
        label: "Claude Code",
        harness: "claude-agent-sdk",
        source: process.env["AGENTOS_DEFAULT_SOURCE"] ?? "github.com/shreyas-lyzr/general-agent",
        model: process.env["AGENTOS_DEFAULT_MODEL"] ?? "claude-haiku-4-5",
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
