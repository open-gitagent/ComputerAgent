import type { HarnessEvent } from "@open-gitagent/protocol";

/**
 * Pluggable audit hook. The server tees every event into the sink right after
 * it lands in the session's replay buffer.
 *
 * The hook is fire-and-forget from the caller's perspective: if the sink
 * throws or rejects, the session is unaffected. Sinks that need durability
 * (e.g. S3, append-only file, syslog) handle their own retries and buffering
 * — the framework guarantees ordering by calling `onEvent` synchronously in
 * emit order, nothing more.
 */
export interface AuditSink {
  onEvent(record: AuditRecord): void | Promise<void>;
}

export interface AuditRecord {
  readonly sessionId: string;
  readonly eventId: number;
  readonly event: HarnessEvent;
  /** Unix millis when the event was emitted on this server. */
  readonly timestamp: number;
}

/** A no-op sink — the default when none is configured. */
export const NullAuditSink: AuditSink = {
  onEvent() {},
};

/** In-memory sink. Useful for tests and small deployments. */
export class MemoryAuditSink implements AuditSink {
  readonly records: AuditRecord[] = [];
  onEvent(record: AuditRecord): void {
    this.records.push(record);
  }
}
