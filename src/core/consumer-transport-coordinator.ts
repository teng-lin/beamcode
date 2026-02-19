import type { AuthContext, ConsumerIdentity } from "../interfaces/auth.js";
import type { WebSocketLike } from "../interfaces/transport.js";
import { inboundMessageSchema } from "../types/inbound-message-schema.js";
import type { InboundMessage } from "../types/inbound-messages.js";
import type { ConsumerTransportCoordinatorDeps } from "./interfaces/session-bridge-coordination.js";
import type { Session } from "./session-store.js";

export class ConsumerTransportCoordinator {
  constructor(private deps: ConsumerTransportCoordinatorDeps) {}

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
      session.anonymousCounter++;
      const identity = this.deps.gatekeeper.createAnonymousIdentity(session.anonymousCounter);
      this.acceptConsumer(ws, session, identity);
    }
  }

  handleConsumerMessage(ws: WebSocketLike, sessionId: string, data: string | Buffer): void {
    const session = this.deps.sessions.get(sessionId);
    if (!session) return;

    session.lastActivity = Date.now();

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
    const msg: InboundMessage = result.data;

    const identity = session.consumerSockets.get(ws);
    if (!identity) return;

    if (!this.deps.gatekeeper.authorize(identity, msg.type)) {
      this.deps.broadcaster.sendTo(ws, {
        type: "error",
        message: `Observers cannot send ${msg.type} messages`,
      });
      return;
    }

    if (!this.deps.gatekeeper.checkRateLimit(ws, session)) {
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
    this.deps.tracer.recv("bridge", msg.type, result.data, { sessionId, traceId });

    this.deps.emit("message:inbound", { sessionId, message: msg });
    this.deps.routeConsumerMessage(session, msg, ws);
  }

  handleConsumerClose(ws: WebSocketLike, sessionId: string): void {
    this.deps.gatekeeper.cancelPendingAuth(ws);
    const session = this.deps.sessions.get(sessionId);
    if (!session) return;

    const identity = session.consumerSockets.get(ws);
    session.consumerSockets.delete(ws);
    session.consumerRateLimiters.delete(ws);
    this.deps.logger.info(
      `Consumer disconnected for session ${sessionId} (${session.consumerSockets.size} consumers)`,
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
      consumerCount: session.consumerSockets.size,
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
    session.consumerSockets.set(ws, identity);
    this.deps.logger.info(
      `Consumer connected for session ${sessionId} (${session.consumerSockets.size} consumers)`,
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
      session: session.state,
    });

    if (session.messageHistory.length > 0) {
      this.deps.broadcaster.sendTo(ws, {
        type: "message_history",
        messages: session.messageHistory,
      });
    }

    if (session.state.capabilities) {
      this.deps.broadcaster.sendTo(ws, {
        type: "capabilities_ready",
        commands: session.state.capabilities.commands,
        models: session.state.capabilities.models,
        account: session.state.capabilities.account,
        skills: session.state.skills,
      });
    }

    if (identity.role === "participant") {
      for (const perm of session.pendingPermissions.values()) {
        this.deps.broadcaster.sendTo(ws, { type: "permission_request", request: perm });
      }
    }

    if (session.queuedMessage) {
      this.deps.broadcaster.sendTo(ws, {
        type: "message_queued",
        consumer_id: session.queuedMessage.consumerId,
        display_name: session.queuedMessage.displayName,
        content: session.queuedMessage.content,
        images: session.queuedMessage.images,
        queued_at: session.queuedMessage.queuedAt,
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
      consumerCount: session.consumerSockets.size,
      identity,
    });

    if (session.backendSession) {
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
