import type {
  EngineCapabilities,
  PermissionRequest,
  PermissionResult,
  UserMessage,
} from "@computeragent/protocol";

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
  private readonly permissionMap = new Map<string, (r: PermissionResult) => void>();
  private subscribed = false;
  readonly abortController = new AbortController();

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
  ) {}

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
      this.permissionMap.set(req.callId, resolve);
    });
  }

  /** Resolve a pending permission with the client's decision. Returns false if unknown. */
  resolvePermission(callId: string, result: PermissionResult): boolean {
    const r = this.permissionMap.get(callId);
    if (!r) return false;
    this.permissionMap.delete(callId);
    r(result);
    return true;
  }

  /** Mark this session as having an SSE subscriber. Returns false if one exists already. */
  attachSubscriber(): boolean {
    if (this.subscribed) return false;
    this.subscribed = true;
    return true;
  }

  /** Detach (e.g. on disconnect or stream end). Lets a future GET re-attach in MVP. */
  detachSubscriber(): void {
    this.subscribed = false;
  }

  cancel(): void {
    if (this.status === "completed" || this.status === "errored") return;
    this.status = "cancelled";
    this.abortController.abort();
    // Unblock any pending permission decisions so the engine can exit.
    for (const [, resolver] of this.permissionMap) {
      resolver({ behavior: "deny", message: "session cancelled" });
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
