import type { AuthContext, ConsumerIdentity } from "../interfaces/auth.js";
import type { WebSocketLike } from "../interfaces/transport.js";
import { CONSUMER_PROTOCOL_VERSION } from "../types/consumer-messages.js";
import { inboundMessageSchema } from "../types/inbound-message-schema.js";
import type { InboundCommand } from "./interfaces/runtime-commands.js";
import type { ConsumerTransportCoordinatorDeps } from "./interfaces/session-bridge-coordination.js";
import type { Session } from "./session-repository.js";

export type ConsumerGatewayDeps = ConsumerTransportCoordinatorDeps;

/**
 * ConsumerGateway owns consumer-side transport concerns:
 * auth, validation, authorization, rate limiting, replay, and dispatch.
 */
export class ConsumerGateway {
  constructor(private deps: ConsumerGatewayDeps) {}

  handleConsumerOpen(ws: WebSocketLike, context: AuthContext): void {
    if (this.deps.gatekeeper.hasAuthenticator()) {
      let authResult: Promise<ConsumerIdentity | null>;
      try {
        authResult = this.deps.gatekeeper.authenticateAsync(ws, context);
      } catch (err) {
        this.rejectConsumer(ws, context.sessionId, err);
        return;
      }
      authResult
        .then((identity) => {
          if (!identity) return;
          const session = this.deps.sessions.get(context.sessionId);
          if (!session) {
            this.rejectMissingSession(ws, context.sessionId);
            return;
          }
          this.acceptConsumer(ws, session, identity);
        })
        .catch((err) => {
          this.rejectConsumer(ws, context.sessionId, err);
        });
    } else {
      const session = this.deps.sessions.get(context.sessionId);
      if (!session) {
        this.rejectMissingSession(ws, context.sessionId);
        return;
      }
      const identity = this.deps.gatekeeper.createAnonymousIdentity(
        this.deps.allocateAnonymousIdentityIndex(session),
      );
      this.acceptConsumer(ws, session, identity);
    }
  }

  handleConsumerMessage(ws: WebSocketLike, sessionId: string, data: string | Buffer): void {
    const session = this.deps.sessions.get(sessionId);
    if (!session) return;

    const payloadSize =
      typeof data === "string" ? Buffer.byteLength(data, "utf-8") : data.byteLength;
    if (payloadSize > this.deps.maxConsumerMessageSize) {
      this.deps.logger.warn(
        `Oversized consumer message rejected for session ${sessionId}: ${payloadSize} bytes (max ${this.deps.maxConsumerMessageSize})`,
      );
      ws.close(1009, "Message Too Big");
      return;
    }

    const raw = typeof data === "string" ? data : data.toString("utf-8");

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.deps.logger.warn(`Failed to parse consumer message: ${raw.substring(0, 200)}`);
      return;
    }

    const result = inboundMessageSchema.safeParse(parsed);
    if (!result.success) {
      this.deps.logger.warn(`Invalid consumer message`, {
        error: result.error.issues,
        raw: raw.substring(0, 200),
      });
      return;
    }
    const msg: InboundCommand = result.data;

    const identity = this.deps.getConsumerIdentity(session, ws);
    if (!identity) return;

    if (!this.deps.gatekeeper.authorize(identity, msg.type)) {
      this.deps.broadcaster.sendTo(ws, {
        type: "error",
        message: `Observers cannot send ${msg.type} messages`,
      });
      return;
    }

    if (!this.deps.checkRateLimit(session, ws)) {
      this.deps.logger.warn(`Rate limit exceeded for consumer in session ${sessionId}`);
      this.deps.metrics?.recordEvent({
        timestamp: Date.now(),
        type: "ratelimit:exceeded",
        sessionId,
        source: "consumer",
      });
      this.deps.broadcaster.sendTo(ws, {
        type: "error",
        message: "Rate limit exceeded. Please slow down your message rate.",
      });
      return;
    }

    const traceId = (result.data as Record<string, unknown>).traceId as string | undefined;
    const hasRequestId = msg.type === "slash_command" || msg.type === "permission_response";
    const requestId = hasRequestId ? msg.request_id : undefined;
    const command = msg.type === "slash_command" ? msg.command : undefined;
    this.deps.tracer.recv("bridge", msg.type, result.data, {
      sessionId,
      traceId,
      requestId,
      command,
      phase: "recv",
    });

    this.deps.emit("message:inbound", { sessionId, message: msg });
    this.deps.routeConsumerMessage(session, msg, ws);
  }

  handleConsumerClose(ws: WebSocketLike, sessionId: string): void {
    this.deps.gatekeeper.cancelPendingAuth(ws);
    const session = this.deps.sessions.get(sessionId);
    if (!session) return;

    const identity = this.deps.unregisterConsumer(session, ws);
    this.deps.logger.info(
      `Consumer disconnected for session ${sessionId} (${this.deps.getConsumerCount(session)} consumers)`,
    );
    if (identity) {
      this.deps.metrics?.recordEvent({
        timestamp: Date.now(),
        type: "consumer:disconnected",
        sessionId,
        userId: identity.userId,
      });
    }
    this.deps.emit("consumer:disconnected", {
      sessionId,
      consumerCount: this.deps.getConsumerCount(session),
      identity,
    });
    this.deps.broadcaster.broadcastPresence(session);
  }

  private rejectConsumer(ws: WebSocketLike, sessionId: string, err: unknown): void {
    const reason = err instanceof Error ? err.message : String(err);
    this.deps.emit("consumer:auth_failed", { sessionId, reason });
    this.deps.metrics?.recordEvent({
      timestamp: Date.now(),
      type: "auth:failed",
      sessionId,
      reason,
    });
    try {
      ws.close(4001, "Authentication failed");
    } catch {
      // ignore close errors
    }
  }

  private acceptConsumer(ws: WebSocketLike, session: Session, identity: ConsumerIdentity): void {
    const sessionId = session.id;
    this.deps.registerConsumer(session, ws, identity);
    this.deps.logger.info(
      `Consumer connected for session ${sessionId} (${this.deps.getConsumerCount(session)} consumers)`,
    );
    this.deps.metrics?.recordEvent({
      timestamp: Date.now(),
      type: "consumer:connected",
      sessionId,
      userId: identity.userId,
    });

    this.deps.broadcaster.sendTo(ws, {
      type: "identity",
      userId: identity.userId,
      displayName: identity.displayName,
      role: identity.role,
    });

    this.deps.gitTracker.resolveGitInfo(session);

    this.deps.broadcaster.sendTo(ws, {
      type: "session_init",
      session: this.deps.getState(session),
      protocol_version: CONSUMER_PROTOCOL_VERSION,
    });

    const messageHistory = this.deps.getMessageHistory(session);
    if (messageHistory.length > 0) {
      this.deps.broadcaster.sendTo(ws, {
        type: "message_history",
        messages: messageHistory,
      });
    }

    const state = this.deps.getState(session);
    if (state.capabilities) {
      this.deps.broadcaster.sendTo(ws, {
        type: "capabilities_ready",
        commands: state.capabilities.commands,
        models: state.capabilities.models,
        account: state.capabilities.account,
        skills: state.skills,
      });
    }

    if (identity.role === "participant") {
      for (const perm of this.deps.getPendingPermissions(session)) {
        this.deps.broadcaster.sendTo(ws, { type: "permission_request", request: perm });
      }
    }

    const queuedMessage = this.deps.getQueuedMessage(session);
    if (queuedMessage) {
      this.deps.broadcaster.sendTo(ws, {
        type: "message_queued",
        consumer_id: queuedMessage.consumerId,
        display_name: queuedMessage.displayName,
        content: queuedMessage.content,
        images: queuedMessage.images,
        queued_at: queuedMessage.queuedAt,
      });
    }

    this.deps.broadcaster.broadcastPresence(session);

    this.deps.emit("consumer:authenticated", {
      sessionId,
      userId: identity.userId,
      displayName: identity.displayName,
      role: identity.role,
    });
    this.deps.emit("consumer:connected", {
      sessionId,
      consumerCount: this.deps.getConsumerCount(session),
      identity,
    });

    if (this.deps.isBackendConnected(session)) {
      this.deps.broadcaster.sendTo(ws, { type: "cli_connected" });
    } else {
      this.deps.broadcaster.sendTo(ws, { type: "cli_disconnected" });
      this.deps.logger.info(
        `Consumer connected but CLI is dead for session ${sessionId}, requesting relaunch`,
      );
      this.deps.emit("backend:relaunch_needed", { sessionId });
    }
  }

  private rejectMissingSession(ws: WebSocketLike, sessionId: string): void {
    const reason = "Session not found";
    this.deps.logger.warn(`Rejecting consumer for unknown session ${sessionId}`);
    this.deps.emit("consumer:auth_failed", { sessionId, reason });
    this.deps.metrics?.recordEvent({
      timestamp: Date.now(),
      type: "auth:failed",
      sessionId,
      reason,
    });
    try {
      ws.close(4404, reason);
    } catch {
      // ignore close errors
    }
  }
}
