/**
 * `MongoTelemetry` — drop-in `AgentTelemetry` implementation that writes
 * to the MongoDB collections AgentOS reads:
 *
 *  - `agent_registry`  → one doc per agent (upserted on `onAgentConstructed`)
 *  - `agent_logs`      → one doc per chat turn (appended on `onChatEnd`)
 *
 * Designed for the library-mode deployment shape: the customer drops
 * `computeragent` into their existing worker (e.g. a Temporal worker pod),
 * passes a `MongoTelemetry` to the `ComputerAgent` constructor, and the
 * AgentOS dashboard sees every run with no extra orchestration.
 *
 * Usage (single-line additive):
 *
 *   import { ComputerAgent, LocalSubstrate } from "computeragent";
 *   import { MongoTelemetry } from "@computeragent/agent-registry-mongo";
 *
 *   const telemetry = new MongoTelemetry({
 *     url: process.env.MONGO_URL!,
 *     database: "agentos",
 *     agent: {
 *       name: "devsupport-agent",
 *       source: "github.com/nord/devsupport-agent",
 *       harness: "claude-agent-sdk",
 *       model: "bedrock/anthropic.claude-sonnet-4-...",
 *     },
 *   });
 *
 *   await using agent = new ComputerAgent({
 *     ...,
 *     telemetry,    // ← that's it
 *   });
 *
 * Telemetry exceptions never propagate up to the agent run (the SDK wraps
 * every call in `safeFireTelemetry`), but we also catch and log them
 * locally here for diagnostics.
 */
import type {
  AgentTelemetry,
  AgentConstructedInfo,
  ChatEndInfo,
  ChatStartInfo,
} from "@computeragent/sdk";
import { MongoClient } from "mongodb";
import { AgentLogStore } from "./audit-log.js";
import { AgentRegistry, type AgentRegistrySpec } from "./registry.js";

export interface MongoTelemetryOptions {
  /** Mongo connection URL. */
  readonly url: string;
  /** Database name (e.g. "agentos"). */
  readonly database: string;
  /**
   * Identity of the agent this telemetry instance represents. `name` is
   * required (it's the primary key in `agent_registry` and the dashboard
   * grouping key in `agent_logs`). Other fields are taken from the SDK
   * lifecycle if you omit them — `name` is the only thing the SDK can't
   * synthesize on its own.
   */
  readonly agent: {
    readonly name: string;
    readonly label?: string;
    readonly harness?: string;     // overridden by SDK's onAgentConstructed.harness
    readonly model?: string;       // overridden by SDK's onAgentConstructed.model
    readonly source?: unknown;     // overridden by SDK's onAgentConstructed.source
    readonly registeredBy?: string; // free-form (hostname, pod name, ...)
  };
  /**
   * Tag that lands in `agent_logs.source` — useful for distinguishing where
   * a run came from in the dashboard. Defaults to "library".
   */
  readonly source?: string;
  /** Override the agent_registry collection name. */
  readonly registryCollection?: string;
  /** Override the agent_logs collection name. */
  readonly logsCollection?: string;
  /**
   * Optional shared MongoClient — pass one if the customer already manages a
   * pool. We won't .close() it on dispose; the caller owns it.
   */
  readonly client?: MongoClient;
  /** Optional logger for telemetry diagnostics. Defaults to noop. */
  readonly onError?: (err: unknown, op: string) => void;
}

/** Per-chat context the SDK threads from `onChatStart` to `onChatEnd`. */
interface ChatCtx {
  readonly startedAt: number;
  readonly message: string;
}

export class MongoTelemetry implements AgentTelemetry {
  private readonly opts: MongoTelemetryOptions;
  private readonly registry: AgentRegistry;
  private readonly logs: AgentLogStore;
  private readonly source: string;
  private readonly ownsClient: boolean;
  private readonly logErr: (err: unknown, op: string) => void;

  constructor(opts: MongoTelemetryOptions) {
    this.opts = opts;
    this.source = opts.source ?? "library";
    this.ownsClient = opts.client === undefined;
    this.logErr =
      opts.onError ??
      ((err, op) => {
        // Default: print one line to stderr; never throw.
        try {
          // eslint-disable-next-line no-console
          console.error(
            `[agent-registry-mongo] ${op} failed:`,
            err instanceof Error ? err.message : String(err),
          );
        } catch {
          /* swallow */
        }
      });

    const sharedClient = opts.client;
    this.registry = new AgentRegistry({
      url: opts.url,
      database: opts.database,
      collection: opts.registryCollection,
      client: sharedClient,
    });
    this.logs = new AgentLogStore({
      url: opts.url,
      database: opts.database,
      collection: opts.logsCollection,
      client: sharedClient,
    });
  }

  // ── AgentTelemetry impl ──────────────────────────────────────────────────

  async onAgentConstructed(info: AgentConstructedInfo): Promise<void> {
    const spec: AgentRegistrySpec = {
      name: this.opts.agent.name,
      label: this.opts.agent.label,
      // The SDK knows the harness + source + model authoritatively. Override
      // whatever the caller passed at construction with the SDK truth, but
      // fall back to the caller's value if the SDK hint is undefined.
      harness: info.harness ?? this.opts.agent.harness ?? "unknown",
      source: info.source ?? this.opts.agent.source ?? null,
      model: info.model ?? this.opts.agent.model,
      registeredBy: this.opts.agent.registeredBy,
    };
    try {
      await this.registry.register(spec);
    } catch (err) {
      this.logErr(err, "onAgentConstructed");
    }
  }

  onChatStart(info: ChatStartInfo): ChatCtx {
    return { startedAt: Date.now(), message: info.message };
  }

  async onChatEnd(info: ChatEndInfo): Promise<void> {
    const ctx = info.context as ChatCtx | undefined;
    try {
      await this.logs.append({
        source: this.source,
        agentName: this.opts.agent.name,
        requester: this.source === "library" ? "library" : null,
        channel: null,
        threadTs: null,
        sessionId: info.sessionId || null,
        query: ctx?.message ?? "",
        reply: info.reply ?? "",
        ok: info.ok,
        error: info.error,
        durationMs:
          info.durationMs ??
          (ctx?.startedAt !== undefined ? Date.now() - ctx.startedAt : undefined),
        inputTokens: info.usage?.inputTokens,
        outputTokens: info.usage?.outputTokens,
        costUsd: info.usage?.costUsd ?? null,
      });
    } catch (err) {
      this.logErr(err, "onChatEnd");
    }
  }

  async onClose(): Promise<void> {
    // If we don't own the MongoClient (caller passed one in), respect their
    // lifecycle and leave it alone.
    if (!this.ownsClient) return;
    try {
      await Promise.all([this.registry.close(), this.logs.close()]);
    } catch (err) {
      this.logErr(err, "onClose");
    }
  }

  // ── Convenience accessors so the customer can read the same data they write ──

  /** Direct access to the registry collection (CRUD beyond the telemetry hook). */
  get registryStore(): AgentRegistry {
    return this.registry;
  }

  /** Direct access to the audit log collection. */
  get logStore(): AgentLogStore {
    return this.logs;
  }
}
