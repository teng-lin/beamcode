import type { AuthContext, ConsumerIdentity } from "../../interfaces/auth.js";
import type { Logger } from "../../interfaces/logger.js";
import type { MetricsCollector } from "../../interfaces/metrics.js";
import type { RateLimiter } from "../../interfaces/rate-limiter.js";
import type { WebSocketLike } from "../../interfaces/transport.js";
import type { PermissionRequest } from "../../types/cli-messages.js";
import type { BridgeEventMap } from "../../types/events.js";
import type { GitInfoTracker } from "../git-info-tracker.js";
import type { MessageTracer } from "../message-tracer.js";
import type { Session } from "../session-repository.js";
import type { InboundCommand } from "./runtime-commands.js";

export type EmitBridgeEvent = <K extends keyof BridgeEventMap>(
  event: K,
  payload: BridgeEventMap[K],
) => void;

export interface SessionStorePort {
  get(sessionId: string): Session | undefined;
}

export interface ConsumerGatekeeperPort {
  hasAuthenticator(): boolean;
  authenticateAsync(ws: WebSocketLike, context: AuthContext): Promise<ConsumerIdentity | null>;
  createAnonymousIdentity(index: number): ConsumerIdentity;
  cancelPendingAuth(ws: WebSocketLike): void;
  authorize(identity: ConsumerIdentity, messageType: InboundCommand["type"]): boolean;
  createRateLimiter(): RateLimiter | undefined;
}

export interface ConsumerBroadcasterPort {
  sendTo(ws: WebSocketLike, msg: Record<string, unknown>): void;
  broadcastPresence(session: Session): void;
}

export interface ConsumerTransportCoordinatorDeps {
  sessions: SessionStorePort;
  gatekeeper: ConsumerGatekeeperPort;
  broadcaster: ConsumerBroadcasterPort;
  gitTracker: GitInfoTracker;
  logger: Logger;
  metrics: MetricsCollector | null;
  emit: EmitBridgeEvent;
  allocateAnonymousIdentityIndex: (session: Session) => number;
  checkRateLimit: (session: Session, ws: WebSocketLike) => boolean;
  getConsumerIdentity: (session: Session, ws: WebSocketLike) => ConsumerIdentity | undefined;
  getConsumerCount: (session: Session) => number;
  getState: (session: Session) => Session["state"];
  getMessageHistory: (session: Session) => Session["messageHistory"];
  getPendingPermissions: (session: Session) => PermissionRequest[];
  getQueuedMessage: (session: Session) => Session["queuedMessage"];
  isBackendConnected: (session: Session) => boolean;
  registerConsumer: (session: Session, ws: WebSocketLike, identity: ConsumerIdentity) => void;
  unregisterConsumer: (session: Session, ws: WebSocketLike) => ConsumerIdentity | undefined;
  routeConsumerMessage: (session: Session, msg: InboundCommand, ws: WebSocketLike) => void;
  maxConsumerMessageSize: number;
  tracer: MessageTracer;
}
