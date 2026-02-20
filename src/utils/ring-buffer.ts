/**
 * Generic fixed-capacity circular buffer.
 * When full, new items overwrite the oldest entry.
 */
export class RingBuffer<T> {
  private buffer: (T | undefined)[];
  private head = 0; // next write position
  private count = 0;

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError("RingBuffer capacity must be a positive integer");
    }
    this.buffer = new Array<T | undefined>(capacity);
  }

  push(item: T): void {
    this.buffer[this.head] = item;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }

  /** Return items in insertion order (oldest first). */
  toArray(): T[] {
    if (this.count === 0) return [];
    const result: T[] = new Array(this.count);
    const start = this.count < this.capacity ? 0 : this.head;
    for (let i = 0; i < this.count; i++) {
      result[i] = this.buffer[(start + i) % this.capacity] as T;
    }
    return result;
  }

  get size(): number {
    return this.count;
  }

  clear(): void {
    this.buffer = new Array<T | undefined>(this.capacity);
    this.head = 0;
    this.count = 0;
  }
}
