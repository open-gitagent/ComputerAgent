import type {
  EngineCapabilities,
  HarnessEvent,
  PermissionRequest,
  PermissionResult,
  SessionStore,
  UserMessage,
} from "@open-gitagent/protocol";
import { ReplayBuffer, type BufferedEvent } from "./replay-buffer.js";
import type { AuditSink } from "./audit.js";

/** Status a session can hold. Pure state machine, no side effects. */
export type SessionStatus =
  | "pending"        // created; engine not started
  | "running"        // engine actively iterating
  | "completed"      // engine finished cleanly
  | "cancelled"      // /cancel POSTed or client disconnected
  | "errored";       // engine threw

interface UserQueueItem {
  readonly value: UserMessage | "end";
}

/**
 * Per-session state and plumbing.
 *
 * Owns:
 *   - User-message queue (producer/consumer): /messages POSTs push, engine pulls.
 *   - Permission map: engine awaits, /permission POSTs resolve.
 *   - AbortController: /cancel triggers, engine observes via ctx.abortSignal.
 *
 * Does NOT own: routing, SSE serialization, fs ops. Single Responsibility.
 */
export class Session {
  status: SessionStatus = "pending";
  private readonly userQueue: UserQueueItem[] = [];
  private readonly userResolvers: ((item: UserQueueItem) => void)[] = [];
  private readonly permissionMap = new Map<
    string,
    { resolve: (r: PermissionResult) => void; originalInput: unknown }
  >();
  private subscriberCount = 0;
  private engineStarted = false;
  readonly abortController = new AbortController();
  readonly events: ReplayBuffer<HarnessEvent>;

  constructor(
    readonly sessionId: string,
    readonly engineName: string,
    readonly loaderName: string,
    readonly workdir: string,
    readonly engineOptions: unknown,
    readonly envs: Readonly<Record<string, string>>,
    readonly capabilities: EngineCapabilities,
    readonly identity: { name: string; version: string; sha?: string },
    readonly cleanup?: () => Promise<void>,
    replayBufferSize: number = 1000,
    private readonly auditSink?: AuditSink,
    readonly sessionStore?: SessionStore,
  ) {
    this.events = new ReplayBuffer<HarnessEvent>(replayBufferSize);
  }

  /**
   * Whether the engine drive has already been kicked off for this session.
   * The kickoff is idempotent — multiple SSE GETs to the same session share
   * one engine drive and read from the replay buffer.
   */
  claimEngineStart(): boolean {
    if (this.engineStarted) return false;
    this.engineStarted = true;
    return true;
  }

  /** Emit an event into the replay buffer. Returns the wire envelope (id + event). */
  emit(event: HarnessEvent): BufferedEvent<HarnessEvent> {
    const wrapped = this.events.push(event);
    if (this.auditSink) {
      try {
        const r = this.auditSink.onEvent({
          sessionId: this.sessionId,
          eventId: wrapped.id,
          event,
          timestamp: Date.now(),
        });
        // If the sink returned a promise, swallow its rejection — audit is best-effort.
        if (r instanceof Promise) r.catch(() => {});
      } catch {
        // Sink threw synchronously; ignore.
      }
    }
    return wrapped;
  }

  /** Push a user message. The engine's iterator will yield it next. */
  pushUserMessage(msg: UserMessage): void {
    this.enqueue({ value: msg });
  }

  /** Signal that no more user messages will come — the engine's iterator returns. */
  endUserMessages(): void {
    this.enqueue({ value: "end" });
  }

  /** AsyncIterable for the engine to read user messages. */
  userMessages(): AsyncIterable<UserMessage> {
    const dequeue = (): Promise<UserQueueItem> => {
      const next = this.userQueue.shift();
      if (next) return Promise.resolve(next);
      return new Promise<UserQueueItem>((resolve) => this.userResolvers.push(resolve));
    };
    return {
      [Symbol.asyncIterator]: (): AsyncIterator<UserMessage> => ({
        next: async () => {
          const item = await dequeue();
          if (item.value === "end") return { value: undefined, done: true };
          return { value: item.value, done: false };
        },
      }),
    };
  }

  /** Engine asks for permission; framework holds the promise until /permission POST resolves it. */
  awaitPermission(req: PermissionRequest): Promise<PermissionResult> {
    return new Promise<PermissionResult>((resolve) => {
      this.permissionMap.set(req.callId, { resolve, originalInput: req.input });
    });
  }

  /**
   * Resolve a pending permission with the client's decision.
   *
   * The wire-level `allow` without explicit `input` must preserve the original
   * tool args — otherwise the engine sees an empty object and tools crash. The
   * caller passes the original-input-aware translator here so the session can
   * use the input it captured at awaitPermission time.
   *
   * Returns false if the callId is unknown.
   */
  resolvePermission(
    callId: string,
    translate: (originalInput: unknown) => PermissionResult,
  ): boolean {
    const entry = this.permissionMap.get(callId);
    if (!entry) return false;
    this.permissionMap.delete(callId);
    entry.resolve(translate(entry.originalInput));
    return true;
  }

  /** Track an SSE subscriber. Multiple concurrent subscribers are allowed. */
  attachSubscriber(): void {
    this.subscriberCount += 1;
  }

  /** Detach (e.g. on disconnect or stream end). */
  detachSubscriber(): void {
    if (this.subscriberCount > 0) this.subscriberCount -= 1;
  }

  get subscribers(): number {
    return this.subscriberCount;
  }

  cancel(): void {
    if (this.status === "completed" || this.status === "errored") return;
    this.status = "cancelled";
    this.abortController.abort();
    // Unblock any pending permission decisions so the engine can exit.
    for (const [, entry] of this.permissionMap) {
      entry.resolve({ behavior: "deny", message: "session cancelled" });
    }
    this.permissionMap.clear();
    // Unblock any user-message consumers.
    this.enqueue({ value: "end" });
  }

  private enqueue(item: UserQueueItem): void {
    const waiter = this.userResolvers.shift();
    if (waiter) waiter(item);
    else this.userQueue.push(item);
  }
}
