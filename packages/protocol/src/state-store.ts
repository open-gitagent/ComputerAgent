import { z } from "zod";

/**
 * Sandbox state snapshot + restore.
 *
 * A `SandboxSnapshot` is a point-in-time capture of a warm sandbox's
 * external state — the workdir (tarball) + metadata + an optional reference
 * to a SessionStore where conversation memory lives. Engine subprocess state
 * isn't snapshotted byte-for-byte; restoration relies on conversation log
 * replay (via SessionStore) + workdir overlay (via attachments) to bring a
 * fresh ComputerAgent back to "where it left off".
 *
 * The shape deliberately mirrors `TaskStore` (Wedge 1.11): the interface
 * lives here; backends implement it; a `kind` wire descriptor lets clients
 * pick a backend per-request.
 */

// ── Wire descriptor (the only thing crossing HTTP) ────────────────────────

/**
 * Lightweight descriptor a client POSTs to choose where snapshots go.
 * `kind` matches a registered builder in the harness server's `stateStores`
 * registry. `options` is opaque — the builder shape decides what it accepts.
 */
export const StateStoreConfig = z.object({
  kind: z.string().min(1),
  options: z.unknown().optional(),
});
export type StateStoreConfig = z.infer<typeof StateStoreConfig>;

// ── Per-snapshot shape ────────────────────────────────────────────────────

/**
 * Aggregated token + cost rollup, accumulated from every `ca_usage_snapshot`
 * during the sandbox's lifetime. Mirrors `TaskUsage` from `task-store.ts` so
 * dashboards can reuse the same renderer. Duplicated rather than re-imported
 * to keep the state-store module self-contained.
 */
export interface SandboxUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheCreationInputTokens?: number;
  readonly cacheReadInputTokens?: number;
  readonly costUsd?: number;
}

/**
 * Optional pointer to where the conversation log lives. If set, restore
 * pins the new sandbox's `sessionStore` to the same kind+options+sessionId
 * so the engine replays prior turns on its first chat. If absent, restored
 * sandbox starts with a fresh conversation (workdir is still recovered).
 *
 * `options` may contain credentials (mongo URL with password). The CALLER
 * is responsible for redacting before save if they don't want them stored
 * — the protocol doesn't second-guess. Bucket-level encryption / scoped
 * IAM is the right defense.
 */
export interface SessionStoreRef {
  readonly kind: string;
  readonly options?: unknown;
  readonly sessionId: string;
}

/**
 * One complete snapshot. Backends serialize this however they like —
 * S3 splits it into `meta.json` + `workdir.tar.gz`; memory keeps it intact;
 * a future GCS backend could do the same as S3.
 */
export interface SandboxSnapshot {
  readonly snapshotId: string;
  readonly sourceSandboxId: string;
  readonly sourceSessionId: string;
  readonly takenAt: Date;
  /** Redacted POST /sandboxes body — used by restore to recreate the agent. */
  readonly config: Record<string, unknown>;
  readonly turnCount: number;
  readonly usage: SandboxUsage;
  readonly sessionStoreRef?: SessionStoreRef;
  /**
   * gzipped tar of the workdir. Stored alongside the metadata; the wire
   * format is the backend's choice. The protocol passes through Buffer
   * — streams are a follow-up wedge if snapshots routinely exceed memory.
   */
  readonly workdirTar: Buffer;
  /** Tarball byte size (compressed). */
  readonly workdirBytes: number;
  /** Number of files captured (uncompressed entry count). For UX in `list`. */
  readonly workdirFileCount: number;
}

/** Snapshot minus the workdir bytes — for cheap listings. */
export type SnapshotSummary = Omit<SandboxSnapshot, "workdirTar">;

/**
 * Filter for `listSnapshots`. All fields optional; backends apply them as
 * additive predicates. Implementations that can't push filters into the
 * underlying store may post-filter (S3 falls back to a prefix scan).
 */
export interface SnapshotFilter {
  readonly sourceSandboxId?: string;
  readonly since?: Date;
  readonly limit?: number;
}

// ── The interface backends implement ──────────────────────────────────────

/**
 * Abstract state storage adapter. Implementations live in their own
 * packages (`@computeragent/state-store-s3`, future redis/gcs/azure
 * backends). The harness server only depends on this interface.
 */
export interface StateStore {
  /**
   * Persist a snapshot. Returns the canonical id (in case the backend
   * normalizes it) + the on-the-wire size. MUST be atomic from the
   * client's perspective — partial uploads should not surface in `list()`.
   */
  save(snap: SandboxSnapshot): Promise<{ snapshotId: string; sizeBytes: number }>;

  /** Full snapshot + tarball. Returns `null` if the id doesn't exist. */
  load(snapshotId: string): Promise<SandboxSnapshot | null>;

  /** Snapshot summaries matching the filter, most-recent first. */
  list(filter?: SnapshotFilter): Promise<readonly SnapshotSummary[]>;

  /** Hard delete. Idempotent — deleting a missing id MUST NOT throw. */
  delete(snapshotId: string): Promise<void>;
}
