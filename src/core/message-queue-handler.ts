/**
 * MessageQueueHandler — extracted from SessionBridge.
 *
 * Manages the single-slot message queue: storing a queued message when the
 * session is busy, updating/cancelling it, and auto-sending when the session
 * becomes idle.
 */

import type { WebSocketLike } from "../interfaces/transport.js";
import type { ConsumerBroadcaster } from "./consumer-broadcaster.js";
import type { Session } from "./session-store.js";

// ─── Types ────────────────────────────────────────────────────────────────────

type ImageAttachment = { media_type: string; data: string };

type SendUserMessage = (
  sessionId: string,
  content: string,
  options?: { images?: ImageAttachment[] },
) => void;

// ─── MessageQueueHandler ──────────────────────────────────────────────────────

export class MessageQueueHandler {
  constructor(
    private broadcaster: ConsumerBroadcaster,
    private sendUserMessage: SendUserMessage,
  ) {}

  handleQueueMessage(
    session: Session,
    msg: {
      type: "queue_message";
      content: string;
      images?: ImageAttachment[];
    },
    ws: WebSocketLike,
  ): void {
    // If session is idle or its status is unknown, send immediately as user_message.
    // Otherwise (e.g. "running", "compacting"), proceed to queue it.
    const status = session.lastStatus;
    if (!status || status === "idle") {
      // Optimistically mark running — the CLI will process this message, but
      // message_start won't arrive until the API starts streaming (1-5s gap).
      // Without this, queue_message arriving in that gap sees lastStatus as
      // null/idle and bypasses the queue.
      session.lastStatus = "running";
      this.sendUserMessage(session.id, msg.content, { images: msg.images });
      return;
    }

    // Reject if a message is already queued
    if (session.queuedMessage) {
      this.broadcaster.sendTo(ws, {
        type: "error",
        message: "A message is already queued for this session",
      });
      return;
    }

    const identity = session.consumerSockets.get(ws);
    if (!identity) return;

    session.queuedMessage = {
      consumerId: identity.userId,
      displayName: identity.displayName,
      content: msg.content,
      images: msg.images,
      queuedAt: Date.now(),
    };

    this.broadcaster.broadcast(session, {
      type: "message_queued",
      consumer_id: identity.userId,
      display_name: identity.displayName,
      content: msg.content,
      images: msg.images,
      queued_at: session.queuedMessage.queuedAt,
    });
  }

  handleUpdateQueuedMessage(
    session: Session,
    msg: {
      type: "update_queued_message";
      content: string;
      images?: ImageAttachment[];
    },
    ws: WebSocketLike,
  ): void {
    if (!session.queuedMessage) return;

    const identity = session.consumerSockets.get(ws);
    if (!identity || identity.userId !== session.queuedMessage.consumerId) {
      this.broadcaster.sendTo(ws, {
        type: "error",
        message: "Only the message author can edit a queued message",
      });
      return;
    }

    session.queuedMessage.content = msg.content;
    session.queuedMessage.images = msg.images;

    this.broadcaster.broadcast(session, {
      type: "queued_message_updated",
      content: msg.content,
      images: msg.images,
    });
  }

  handleCancelQueuedMessage(session: Session, ws: WebSocketLike): void {
    if (!session.queuedMessage) return;

    const identity = session.consumerSockets.get(ws);
    if (!identity || identity.userId !== session.queuedMessage.consumerId) {
      this.broadcaster.sendTo(ws, {
        type: "error",
        message: "Only the message author can cancel a queued message",
      });
      return;
    }

    session.queuedMessage = null;
    this.broadcaster.broadcast(session, { type: "queued_message_cancelled" });
  }

  autoSendQueuedMessage(session: Session): void {
    if (!session.queuedMessage) return;
    const queued = session.queuedMessage;
    session.queuedMessage = null;
    this.broadcaster.broadcast(session, { type: "queued_message_sent" });
    this.sendUserMessage(session.id, queued.content, {
      images: queued.images,
    });
  }
}
