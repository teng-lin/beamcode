import { randomUUID } from "node:crypto";

/**
 * A message wrapped with sequencing metadata at the transport boundary.
 * Used for reconnection replay and backpressure — wraps around ConsumerMessage
 * at the point of delivery, NOT inside UnifiedMessage.
 */
export interface SequencedMessage<T> {
  /** Monotonically increasing sequence number (1-based). */
  seq: number;
  /** Unique message identifier. */
  message_id: string;
  /** Unix epoch milliseconds when sequenced. */
  timestamp: number;
  /** The wrapped payload. */
  payload: T;
}

/**
 * Assigns monotonically increasing sequence numbers to payloads.
 * Each sequencer instance maintains its own independent counter.
 */
export class MessageSequencer<T> {
  private seq = 0;

  /** Wrap a payload in a SequencedMessage with the next sequence number. */
  next(payload: T): SequencedMessage<T> {
    this.seq++;
    return {
      seq: this.seq,
      message_id: randomUUID(),
      timestamp: Date.now(),
      payload,
    };
  }

  /** Reset the sequence counter to zero. */
  reset(): void {
    this.seq = 0;
  }

  /** Current sequence number (the last assigned value, 0 if none assigned). */
  get currentSeq(): number {
    return this.seq;
  }
}
