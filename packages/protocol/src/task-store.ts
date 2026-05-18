import { z } from "zod";

/**
 * Task-driven background execution storage.
 *
 * Sessions persist per-turn conversation memory. Tasks persist the entire
 * run lifecycle — status, every event, usage rollup, artifacts — so a
 * client can fire-and-forget a task, walk away, and come back later via
 * `taskId` to poll status / read events / fetch produced files.
 *
 * Shape mirrors `SessionStore` deliberately: an interface defined here +
 * a wire descriptor + a registry of builders in the harness server.
 * Backend authors implement this interface; the registry decides what
 * `kind` strings clients can request.
 */

// ── Wire descriptor (the only piece that crosses HTTP) ────────────────────

/**
 * Lightweight descriptor a client POSTs in `POST /tasks`. The server's
 * `taskStores` registry looks up `kind` and instantiates a live store via
 * the matching builder. `options` is opaque — the builder decides the
 * shape.
 *
 * `kind` is intentionally open. Unknown kinds return 400 with an
 * `available` list.
 */
export const TaskStoreConfig = z.object({
  kind: z.string().min(1),
  options: z.unknown().optional(),
});
export type TaskStoreConfig = z.infer<typeof TaskStoreConfig>;

// ── Status state machine ──────────────────────────────────────────────────

/**
 * Task lifecycle states. Transitions:
 *   queued → running → (complete | errored | cancelled)
 *
 * `queued` is transient — set on `createTask`, flipped to `running` once
 * the runner has actually started consuming the user message. Useful for
 * eventual job-queue setups where the runner may not pick up immediately.
 */
export type TaskStatus =
  | "queued"
  | "running"
  | "complete"
  | "errored"
  | "cancelled";

// ── Per-event persistence shape ───────────────────────────────────────────

/**
 * One row of the task's event log. Each `HarnessEvent` the runner observes
 * gets wrapped with a monotonic `id` and a write timestamp before persisting.
 * `id` lets clients poll `?since=N` and get only new events; `ts` lets them
 * render timelines without coordinate guessing.
 *
 * `payload` is the original event minus its `kind` (which is on the wrapper).
 * Stored as JSON-serializable arbitrary structure — the schema is whatever
 * the underlying engine emits.
 */
export interface PersistedEvent {
  readonly id: number;
  readonly ts: Date;
  readonly kind: string;
  readonly payload: unknown;
}

// ── Task document (storage-side shape) ────────────────────────────────────

/**
 * Aggregated token + cost rollup, accumulated from every
 * `ca_usage_snapshot` the task emits. Mirrors the SDK's `UsageRollup` so
 * dashboards can show the same shape they show for `/run` results.
 */
export interface TaskUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheCreationInputTokens?: number;
  readonly cacheReadInputTokens?: number;
  readonly costUsd?: number;
}

/**
 * Metadata for one artifact produced by the task. The store may keep the
 * bytes inline (`chunkId` set, backend-specific reference) OR rely on the
 * runner persisting them under a stable workdir (`chunkId` absent).
 */
export interface TaskArtifactRef {
  readonly path: string;
  readonly bytes: number;
  readonly chunkId?: string;
}

/**
 * The full document the store maintains per task. Persisted backends should
 * serialize this shape on `appendEvent` / `updateStatus`; in-memory backends
 * just hold the live object.
 */
export interface TaskDoc {
  readonly taskId: string;
  readonly sessionId: string;
  readonly status: TaskStatus;
  /**
   * The original `POST /tasks` body with secrets redacted. Useful for
   * debugging and replay; never includes API keys or session-store
   * credentials. The store author is responsible for the redaction
   * before persisting.
   */
  readonly config?: Record<string, unknown>;
  readonly events: readonly PersistedEvent[];
  readonly usage?: TaskUsage;
  readonly startedAt: Date;
  readonly endedAt?: Date;
  readonly lastEventAt: Date;
  readonly error?: string;
  readonly artifactRefs?: readonly TaskArtifactRef[];
}

/**
 * Initial fields the runner supplies on `createTask`. The store fills in
 * `events: []`, `startedAt: now`, `lastEventAt: now`, `status: "queued"`
 * unless overridden.
 */
export interface TaskInit {
  readonly sessionId: string;
  readonly config?: Record<string, unknown>;
  /** Optional override for `status`. Default `"queued"`. */
  readonly status?: TaskStatus;
}

/**
 * Lightweight summary returned by `listTasks` — same shape as `TaskDoc`
 * minus the events array. Designed for paginated dashboards.
 */
export type TaskSummary = Omit<TaskDoc, "events">;

/**
 * Filter for `listTasks`. All fields optional; backends apply them as
 * additive predicates. Implementations that don't support a filter field
 * should ignore it (caller can post-filter), not throw.
 */
export interface TaskFilter {
  readonly status?: TaskStatus | readonly TaskStatus[];
  readonly sessionId?: string;
  readonly since?: Date;
  readonly limit?: number;
}

// ── The interface backends implement ──────────────────────────────────────

/**
 * Abstract task storage adapter. Implementations live in their own packages
 * (`@computeragent/task-store-mongo`, future redis / sqlite / s3 backends).
 * The harness server only depends on this interface.
 */
export interface TaskStore {
  /**
   * Reserve a `taskId`. After this returns, `load(taskId)` returns the
   * partial doc and `appendEvent` / `updateStatus` succeed.
   *
   * Implementations must reject (or upsert) cleanly if the same `taskId`
   * is created twice — caller's responsibility to make ids unique.
   */
  createTask(taskId: string, init: TaskInit): Promise<void>;

  /**
   * Append one event to the task's log. Implementations MUST preserve the
   * caller-supplied `id` to maintain total ordering across processes.
   * Idempotent on duplicate `id` (caller's safety net for retries).
   */
  appendEvent(taskId: string, ev: PersistedEvent): Promise<void>;

  /**
   * Patch the task document — status, usage rollup, endedAt, error, etc.
   * Atomicity is best-effort; the runner only calls this from a single
   * code path per task so contention is rare.
   */
  updateStatus(
    taskId: string,
    status: TaskStatus,
    fields?: Partial<Omit<TaskDoc, "taskId" | "status" | "events">>,
  ): Promise<void>;

  /** Full doc + all events. Returns `null` if the task doesn't exist. */
  load(taskId: string): Promise<TaskDoc | null>;

  /**
   * Slice of events with `id > since`. Used by JSON polling
   * (`GET /tasks/:id/events?since=N`). Implementations should keep this
   * cheap (server-side projection or a covered index).
   */
  loadEventsSince(taskId: string, since: number): Promise<readonly PersistedEvent[]>;

  /** Recent tasks matching the filter, ordered most-recent first. */
  listTasks(filter?: TaskFilter): Promise<readonly TaskSummary[]>;

  /** Hard delete. Used by `DELETE /tasks/:id` after the runner has cleaned up. */
  delete(taskId: string): Promise<void>;

  /**
   * Optional artifact storage. Backends that don't support binary blobs
   * leave both undefined; the harness server then returns 410 Gone for
   * `GET /tasks/:id/artifact` after task end, and recommends the caller
   * fetch artifacts while the task is still `running` from the
   * substrate's live workdir.
   */
  attachArtifact?(taskId: string, path: string, bytes: Buffer): Promise<{ chunkId: string }>;
  loadArtifact?(taskId: string, path: string): Promise<Buffer | null>;
}
