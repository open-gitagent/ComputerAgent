/**
 * Per-session ring buffer of emitted events. Underwrites Last-Event-ID resume.
 *
 * Producer (the engine drive) calls `push(event)` exactly once per event. Each
 * push assigns a monotonic `id`. The buffer trims its head to `maxSize`,
 * dropping the oldest events when full.
 *
 * Consumers (SSE route handlers) call `iterate({ since })` to replay events
 * with id > since and then tail new events as they arrive. Multiple consumers
 * can iterate concurrently — each gets its own cursor.
 *
 * The buffer terminates on `close()`. All in-flight iterators receive a `done`
 * result after draining whatever is still ahead of their cursor.
 */
export interface BufferedEvent<T> {
  readonly id: number;
  readonly event: T;
}

export class ReplayBuffer<T> {
  private readonly buffer: BufferedEvent<T>[] = [];
  private readonly waiters: (() => void)[] = [];
  private nextId = 0;
  private closedFlag = false;

  constructor(private readonly maxSize: number = 1000) {}

  /** Append an event. Returns the wrapped record with its assigned id. */
  push(event: T): BufferedEvent<T> {
    const wrapped: BufferedEvent<T> = { id: this.nextId++, event };
    if (this.closedFlag) return wrapped;
    this.buffer.push(wrapped);
    if (this.buffer.length > this.maxSize) this.buffer.shift();
    this.wakeAll();
    return wrapped;
  }

  /** Mark the buffer as closed. Iterators drain then return done. */
  close(): void {
    if (this.closedFlag) return;
    this.closedFlag = true;
    this.wakeAll();
  }

  get isClosed(): boolean {
    return this.closedFlag;
  }

  /** Id of the most recently pushed event, or -1 if none. */
  get lastEventId(): number {
    return this.nextId - 1;
  }

  /** Id of the oldest event still retained, or -1 if buffer is empty. */
  get firstRetainedId(): number {
    return this.buffer[0]?.id ?? -1;
  }

  /**
   * Yield buffered events with id > since, then tail new events until close.
   *
   * If `since` is older than the buffer's first retained id, the client has
   * fallen behind the ring — they'll see the buffer's tail but miss the gap.
   * The caller is responsible for surfacing that to the client (we deliberately
   * don't throw here; partial replay is better than no replay).
   */
  iterate(opts: { since?: number } = {}): AsyncIterable<BufferedEvent<T>> {
    const start = opts.since ?? -1;
    let cursor = start;
    const buf = this;
    return {
      [Symbol.asyncIterator](): AsyncIterator<BufferedEvent<T>> {
        return {
          next: async (): Promise<IteratorResult<BufferedEvent<T>>> => {
            for (;;) {
              const next = buf.findAfter(cursor);
              if (next) {
                cursor = next.id;
                return { value: next, done: false };
              }
              if (buf.closedFlag) return { value: undefined as never, done: true };
              await new Promise<void>((resolve) => buf.waiters.push(resolve));
            }
          },
        };
      },
    };
  }

  private findAfter(cursor: number): BufferedEvent<T> | undefined {
    for (const e of this.buffer) if (e.id > cursor) return e;
    return undefined;
  }

  private wakeAll(): void {
    const pending = this.waiters.splice(0);
    for (const w of pending) w();
  }
}
