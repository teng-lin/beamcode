/**
 * AsyncMessageQueue<T> — generic async iterable queue.
 *
 * Extracted from adapter sessions (Phase 4 / H2) where 4 of 5 adapters
 * duplicated identical ~50-line queue implementations.
 *
 * Usage:
 *   const queue = new AsyncMessageQueue<UnifiedMessage>();
 *   queue.enqueue(msg);      // producer side
 *   queue.finish();           // signal end of stream
 *   for await (const msg of queue) { ... }  // consumer side
 */

export class AsyncMessageQueue<T> {
  private readonly queue: T[] = [];
  private resolve: ((value: IteratorResult<T>) => void) | null = null;
  private done = false;

  /** Push an item into the queue, waking a pending consumer if one is waiting. */
  enqueue(item: T): void {
    if (this.done) return;
    if (this.resolve) {
      const r = this.resolve;
      this.resolve = null;
      r({ value: item, done: false });
    } else {
      this.queue.push(item);
    }
  }

  /** Signal that no more items will be produced. */
  finish(): void {
    if (this.done) return;
    this.done = true;

    if (this.resolve) {
      const r = this.resolve;
      this.resolve = null;
      r({ value: undefined, done: true } as IteratorResult<T>);
    }
  }

  /** Whether the queue has been finished. */
  get isFinished(): boolean {
    return this.done;
  }

  /** AsyncIterable interface — use with `for await`. */
  [Symbol.asyncIterator](): AsyncIterator<T> {
    const self = this;
    return {
      next(): Promise<IteratorResult<T>> {
        const queued = self.queue.shift();
        if (queued !== undefined) {
          return Promise.resolve({ value: queued, done: false });
        }
        if (self.done) {
          return Promise.resolve({ value: undefined, done: true } as IteratorResult<T>);
        }
        return new Promise<IteratorResult<T>>((resolve) => {
          self.resolve = resolve;
        });
      },
    };
  }
}
