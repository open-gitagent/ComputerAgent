import { Session } from "./session.js";

/** Default time-to-live for an idle session, in milliseconds. */
const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1 hour

interface Entry {
  readonly session: Session;
  expiresAt: number;
}

/**
 * In-memory session registry with TTL eviction.
 *
 * Pattern: Registry — looks up sessions by id, owns lifecycle + cleanup.
 * Not concurrency-safe across processes; that's a Wedge 1.5 concern (Redis-backed registry).
 */
export class SessionRegistry {
  private readonly map = new Map<string, Entry>();

  constructor(private readonly ttlMs: number = DEFAULT_TTL_MS) {}

  add(session: Session): void {
    this.map.set(session.sessionId, { session, expiresAt: Date.now() + this.ttlMs });
  }

  get(id: string): Session | undefined {
    const entry = this.map.get(id);
    if (!entry) return undefined;
    if (entry.expiresAt < Date.now()) {
      this.delete(id);
      return undefined;
    }
    entry.expiresAt = Date.now() + this.ttlMs; // touch
    return entry.session;
  }

  /** Remove the session and run any loader cleanup. Idempotent. */
  async delete(id: string): Promise<void> {
    const entry = this.map.get(id);
    if (!entry) return;
    this.map.delete(id);
    if (entry.session.cleanup) {
      await entry.session.cleanup();
    }
  }

  size(): number {
    return this.map.size;
  }

  /** Expire all entries past their TTL. Call from a periodic timer or in tests. */
  reapExpired(now: number = Date.now()): string[] {
    const expired: string[] = [];
    for (const [id, entry] of this.map) {
      if (entry.expiresAt < now) expired.push(id);
    }
    for (const id of expired) void this.delete(id);
    return expired;
  }
}
