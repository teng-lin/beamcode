/**
 * ConsumerBroadcaster — extracted from SessionBridge (Phase 2).
 *
 * Handles all consumer-facing transport: broadcasting to all consumers,
 * broadcasting to participants only, and sending to individual consumers.
 */

import type { Logger } from "../interfaces/logger.js";
import type { WebSocketLike } from "../interfaces/transport.js";
import type { ConsumerMessage } from "../types/consumer-messages.js";
import type { SessionState } from "../types/session-state.js";
import type { Session } from "./session-store.js";
import { toPresenceEntry } from "./session-store.js";

// ─── Constants ───────────────────────────────────────────────────────────────

export const MAX_CONSUMER_MESSAGE_SIZE = 262_144; // 256 KB
export const BACKPRESSURE_THRESHOLD = 1_048_576; // 1 MB

// ─── Types ───────────────────────────────────────────────────────────────────

export type BroadcastCallback = (sessionId: string, msg: ConsumerMessage) => void;

// ─── ConsumerBroadcaster ─────────────────────────────────────────────────────

export class ConsumerBroadcaster {
  private logger: Logger;
  private onBroadcast?: BroadcastCallback;

  constructor(logger: Logger, onBroadcast?: BroadcastCallback) {
    this.logger = logger;
    this.onBroadcast = onBroadcast;
  }

  /** Broadcast a message to all consumers in a session (with backpressure protection). */
  broadcast(session: Session, msg: ConsumerMessage): void {
    const json = JSON.stringify(msg);
    const failed: WebSocketLike[] = [];
    for (const ws of session.consumerSockets.keys()) {
      if (ws.bufferedAmount !== undefined && ws.bufferedAmount > BACKPRESSURE_THRESHOLD) {
        this.logger.warn(
          `Dropping message to consumer in session ${session.id}: backpressure (buffered=${ws.bufferedAmount})`,
        );
        continue;
      }
      try {
        ws.send(json);
      } catch (err) {
        this.logger.warn(
          `Failed to send message to consumer in session ${session.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
        failed.push(ws);
      }
    }
    for (const ws of failed) {
      session.consumerSockets.delete(ws);
    }
    this.onBroadcast?.(session.id, msg);
  }

  /**
   * Broadcast a message to participants only (excludes observers).
   * No backpressure check — participant-only messages (permission_request,
   * process_output) are control-plane and must always be delivered.
   */
  broadcastToParticipants(session: Session, msg: ConsumerMessage): void {
    const json = JSON.stringify(msg);
    const failed: WebSocketLike[] = [];
    for (const [ws, identity] of session.consumerSockets.entries()) {
      if (identity.role === "observer") continue;
      try {
        ws.send(json);
      } catch (err) {
        this.logger.warn(
          `Failed to send message to participant in session ${session.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
        failed.push(ws);
      }
    }
    for (const ws of failed) {
      session.consumerSockets.delete(ws);
    }
    this.onBroadcast?.(session.id, msg);
  }

  /** Send a message to a single consumer socket. */
  sendTo(ws: WebSocketLike, msg: ConsumerMessage): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch (err) {
      this.logger.warn("Failed to send message to consumer", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Broadcast presence update to all consumers. */
  broadcastPresence(session: Session): void {
    const consumers = Array.from(session.consumerSockets.values()).map(toPresenceEntry);
    this.broadcast(session, { type: "presence_update", consumers });
  }

  /** Broadcast a session name update. */
  broadcastNameUpdate(session: Session, name: string): void {
    this.broadcast(session, { type: "session_name_update", name });
  }

  /** Broadcast resume_failed to all consumers. */
  broadcastResumeFailed(session: Session, sessionId: string): void {
    this.broadcast(session, { type: "resume_failed", sessionId });
  }

  /** Broadcast process output to participants only. */
  broadcastProcessOutput(session: Session, stream: "stdout" | "stderr", data: string): void {
    this.broadcastToParticipants(session, { type: "process_output", stream, data });
  }

  /** Broadcast watchdog state update. */
  broadcastWatchdogState(
    session: Session,
    watchdog: { gracePeriodMs: number; startedAt: number } | null,
  ): void {
    this.broadcast(session, {
      type: "session_update",
      session: { watchdog } as Partial<SessionState>,
    });
  }

  /** Broadcast circuit breaker state update. */
  broadcastCircuitBreakerState(
    session: Session,
    circuitBreaker: { state: string; failureCount: number; recoveryTimeRemainingMs: number },
  ): void {
    this.broadcast(session, {
      type: "session_update",
      session: { circuitBreaker } as Partial<SessionState>,
    });
  }
}
