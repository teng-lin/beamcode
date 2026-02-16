import { randomUUID } from "node:crypto";
import type { SequencedMessage } from "../core/types/sequenced-message.js";
import type { ConsumerMessage } from "../types/consumer-messages.js";

export interface ReconnectionHandlerOptions {
  /** Maximum messages retained per session for replay (default: 500). */
  maxHistoryPerSession?: number;
  /** Number of most recent messages sent to a new connection (default: 20). */
  initialReplayCount?: number;
}

/**
 * Manages stable consumer IDs, message history per session, and replay
 * for reconnecting consumers.
 */
export class ReconnectionHandler {
  private readonly maxHistoryPerSession: number;
  private readonly initialReplayCount: number;

  /** Session ID → ordered message history. */
  private readonly sessionHistory = new Map<string, SequencedMessage<ConsumerMessage>[]>();

  /** Consumer ID → session ID mapping (for lookups). */
  private readonly consumerToSession = new Map<string, string>();

  /** Consumer ID → last acknowledged sequence number. */
  private readonly consumerLastSeen = new Map<string, number>();

  constructor(options?: ReconnectionHandlerOptions) {
    this.maxHistoryPerSession = options?.maxHistoryPerSession ?? 500;
    this.initialReplayCount = options?.initialReplayCount ?? 20;
  }

  /**
   * Register a consumer for a session and return a stable consumer ID.
   * If `existingId` is provided and known, the same ID is reused (reconnection).
   */
  registerConsumer(sessionId: string, existingId?: string): string {
    if (existingId && this.consumerToSession.has(existingId)) {
      // Reconnection — reuse existing ID
      return existingId;
    }

    const consumerId = existingId ?? randomUUID();
    this.consumerToSession.set(consumerId, sessionId);

    // Ensure session history exists
    if (!this.sessionHistory.has(sessionId)) {
      this.sessionHistory.set(sessionId, []);
    }

    return consumerId;
  }

  /** Record an outbound message for potential replay. */
  recordMessage(sessionId: string, message: SequencedMessage<ConsumerMessage>): void {
    let history = this.sessionHistory.get(sessionId);
    if (!history) {
      history = [];
      this.sessionHistory.set(sessionId, history);
    }

    history.push(message);

    // Trim oldest messages when history exceeds capacity
    if (history.length > this.maxHistoryPerSession) {
      const excess = history.length - this.maxHistoryPerSession;
      history.splice(0, excess);
    }
  }

  /**
   * Get messages to replay on reconnect.
   * Returns all messages with seq > lastSeenSeq.
   */
  getReplayMessages(sessionId: string, lastSeenSeq: number): SequencedMessage<ConsumerMessage>[] {
    const history = this.sessionHistory.get(sessionId);
    if (!history) return [];

    return history.filter((msg) => msg.seq > lastSeenSeq);
  }

  /**
   * Get initial messages for a brand-new connection.
   * Returns the most recent `initialReplayCount` messages.
   */
  getInitialMessages(sessionId: string): SequencedMessage<ConsumerMessage>[] {
    const history = this.sessionHistory.get(sessionId);
    if (!history || history.length === 0) return [];

    return history.slice(-this.initialReplayCount);
  }

  /** Update the last-seen sequence number for a consumer. */
  updateLastSeen(consumerId: string, seq: number): void {
    this.consumerLastSeen.set(consumerId, seq);
  }

  /** Get the last-seen sequence number for a consumer (0 if unknown). */
  getLastSeen(consumerId: string): number {
    return this.consumerLastSeen.get(consumerId) ?? 0;
  }

  /** Remove all state for a session. */
  removeSession(sessionId: string): void {
    this.sessionHistory.delete(sessionId);

    // Remove all consumers associated with this session
    for (const [consumerId, sid] of this.consumerToSession) {
      if (sid === sessionId) {
        this.consumerToSession.delete(consumerId);
        this.consumerLastSeen.delete(consumerId);
      }
    }
  }

  /** Remove a single consumer's state. */
  removeConsumer(consumerId: string): void {
    this.consumerToSession.delete(consumerId);
    this.consumerLastSeen.delete(consumerId);
  }
}
