import type { SequencedMessage } from "../core/types/sequenced-message.js";
import type { ConsumerMessage } from "../types/consumer-messages.js";

/** Message types that must never be dropped under backpressure. */
const DEFAULT_CRITICAL_TYPES: ReadonlySet<string> = new Set([
  "permission_request",
  "permission_cancelled",
  "result",
  "session_init",
  "error",
  "cli_disconnected",
  "cli_connected",
]);

export interface ConsumerChannelOptions {
  /** Queue size at which non-critical messages start being dropped (default: 1000). */
  highWaterMark?: number;
  /** Queue size at which enqueue returns false — caller should disconnect (default: 5000). */
  maxQueueSize?: number;
  /** Message types that are never dropped under backpressure. */
  criticalTypes?: string[];
}

/**
 * Per-consumer outbound message channel with backpressure.
 *
 * Operates on plaintext SequencedMessage<ConsumerMessage> so that message
 * types can be inspected for priority-based dropping before encryption.
 */
export class ConsumerChannel {
  private readonly queue: SequencedMessage<ConsumerMessage>[] = [];
  private readonly highWaterMark: number;
  private readonly maxQueueSize: number;
  private readonly criticalTypes: ReadonlySet<string>;

  constructor(options?: ConsumerChannelOptions) {
    this.highWaterMark = options?.highWaterMark ?? 1000;
    this.maxQueueSize = options?.maxQueueSize ?? 5000;
    this.criticalTypes = options?.criticalTypes
      ? new Set(options.criticalTypes)
      : DEFAULT_CRITICAL_TYPES;
  }

  /**
   * Enqueue a message for delivery.
   * Returns false if the queue has exceeded maxQueueSize (overflow — caller should disconnect).
   */
  enqueue(message: SequencedMessage<ConsumerMessage>): boolean {
    if (this.queue.length >= this.maxQueueSize) {
      return false;
    }

    if (this.queue.length >= this.highWaterMark) {
      // Under backpressure: only accept critical messages
      if (this.criticalTypes.has(message.payload.type)) {
        this.queue.push(message);
      }
      // Non-critical messages are silently dropped
      return true;
    }

    this.queue.push(message);
    return true;
  }

  /** Drain all queued messages (returns and clears the queue). */
  drain(): SequencedMessage<ConsumerMessage>[] {
    return this.queue.splice(0);
  }

  /** Number of messages currently in the queue. */
  get queueSize(): number {
    return this.queue.length;
  }

  /** Whether the queue has exceeded the high water mark. */
  get isOverflowing(): boolean {
    return this.queue.length >= this.highWaterMark;
  }
}
