/**
 * Single-producer-single-consumer async channel.
 *
 * Used by `runSession` to merge engine-iterator output and out-of-band events
 * (like permission requests pushed from inside `onPermissionRequest`) into a
 * single AsyncIterable for SSE serialization.
 *
 * Backpressure-naive: pushes never block. The only consumer is the SSE writer
 * which streams as fast as the network allows; for a single in-process use this
 * is fine and keeps the implementation tiny.
 */
export class EventChannel<T> implements AsyncIterable<T> {
  private readonly queue: T[] = [];
  private readonly waiters: ((r: IteratorResult<T>) => void)[] = [];
  private closed = false;

  push(value: T): void {
    if (this.closed) return;
    const w = this.waiters.shift();
    if (w) w({ value, done: false });
    else this.queue.push(value);
  }

  close(): void {
    this.closed = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()!({ value: undefined as never, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const v = this.queue.shift();
        if (v !== undefined) return Promise.resolve({ value: v, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise<IteratorResult<T>>((resolve) => this.waiters.push(resolve));
      },
    };
  }
}
