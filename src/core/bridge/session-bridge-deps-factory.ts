import type { ConsumerIdentity } from "../../interfaces/auth.js";
import type { Logger } from "../../interfaces/logger.js";
import type { MetricsCollector } from "../../interfaces/metrics.js";
import type { WebSocketLike } from "../../interfaces/transport.js";
import type { InitializeCommand } from "../../types/cli-messages.js";
import type { BridgeEventMap } from "../../types/events.js";
import type { BackendConnectorDeps } from "../backend-connector.js";
import type { CapabilitiesPolicy } from "../capabilities-policy.js";
import type { ConsumerBroadcaster } from "../consumer-broadcaster.js";
import type { ConsumerGatekeeper } from "../consumer-gatekeeper.js";
import type { ConsumerGatewayDeps } from "../consumer-gateway.js";
import type { GitInfoTracker } from "../git-info-tracker.js";
import type { AdapterResolver } from "../interfaces/adapter-resolver.js";
import type { BackendAdapter } from "../interfaces/backend-adapter.js";
import type { InboundCommand } from "../interfaces/runtime-commands.js";
import type { MessageQueueHandler } from "../message-queue-handler.js";
import type { MessageTracer } from "../message-tracer.js";
import type { Session, SessionRepository } from "../session-repository.js";
import type { SessionRuntime } from "../session-runtime.js";
import type { UnifiedMessage } from "../types/unified-message.js";
import type { UnifiedMessageRouterDeps } from "../unified-message-router.js";

type EmitBridgeEvent = (
  type: keyof BridgeEventMap,
  payload: BridgeEventMap[keyof BridgeEventMap],
) => void;

type CapabilitiesPolicyStateAccessors = {
  getState: (session: Session) => Session["state"];
  setState: (session: Session, state: Session["state"]) => void;
  getPendingInitialize: (session: Session) => Session["pendingInitialize"];
  setPendingInitialize: (session: Session, pendingInitialize: Session["pendingInitialize"]) => void;
  trySendRawToBackend: (session: Session, ndjson: string) => "sent" | "unsupported" | "no_backend";
  registerCLICommands: (session: Session, commands: InitializeCommand[]) => void;
};

type QueueStateAccessors = {
  getLastStatus: (session: Session) => Session["lastStatus"];
  setLastStatus: (session: Session, status: Session["lastStatus"]) => void;
  getQueuedMessage: (session: Session) => Session["queuedMessage"];
  setQueuedMessage: (session: Session, queued: Session["queuedMessage"]) => void;
  getConsumerIdentity: (session: Session, ws: WebSocketLike) => ConsumerIdentity | undefined;
};

export function createCapabilitiesPolicyStateAccessors(
  runtime: (session: Session) => SessionRuntime,
): CapabilitiesPolicyStateAccessors {
  return {
    getState: (session: Session) => runtime(session).getState(),
    setState: (session: Session, state: Session["state"]) => runtime(session).setState(state),
    getPendingInitialize: (session: Session) => runtime(session).getPendingInitialize(),
    setPendingInitialize: (session: Session, pendingInitialize: Session["pendingInitialize"]) =>
      runtime(session).setPendingInitialize(pendingInitialize),
    trySendRawToBackend: (session: Session, ndjson: string) =>
      runtime(session).trySendRawToBackend(ndjson),
    registerCLICommands: (session: Session, commands: InitializeCommand[]) =>
      runtime(session).registerCLICommands(commands),
  };
}

export function createQueueStateAccessors(
  runtime: (session: Session) => SessionRuntime,
): QueueStateAccessors {
  return {
    getLastStatus: (session: Session) => runtime(session).getLastStatus(),
    setLastStatus: (session: Session, status: Session["lastStatus"]) =>
      runtime(session).setLastStatus(status),
    getQueuedMessage: (session: Session) => runtime(session).getQueuedMessage(),
    setQueuedMessage: (session: Session, queued: Session["queuedMessage"]) =>
      runtime(session).setQueuedMessage(queued),
    getConsumerIdentity: (session: Session, ws: WebSocketLike) =>
      runtime(session).getConsumerIdentity(ws),
  };
}

export function createUnifiedMessageRouterDeps(params: {
  broadcaster: ConsumerBroadcaster;
  capabilitiesPolicy: CapabilitiesPolicy;
  queueHandler: MessageQueueHandler;
  gitTracker: GitInfoTracker;
  gitResolver: UnifiedMessageRouterDeps["gitResolver"];
  emitEvent: (type: string, payload: unknown) => void;
  persistSession: (session: Session) => void;
  maxMessageHistoryLength: number;
  tracer: MessageTracer;
  runtime: (session: Session) => SessionRuntime;
}): UnifiedMessageRouterDeps {
  return {
    broadcaster: params.broadcaster,
    capabilitiesPolicy: params.capabilitiesPolicy,
    queueHandler: params.queueHandler,
    gitTracker: params.gitTracker,
    gitResolver: params.gitResolver,
    emitEvent: params.emitEvent,
    persistSession: params.persistSession,
    maxMessageHistoryLength: params.maxMessageHistoryLength,
    tracer: params.tracer,
    getState: (session: Session) => params.runtime(session).getState(),
    setState: (session: Session, state: Session["state"]) =>
      params.runtime(session).setState(state),
    setBackendSessionId: (session: Session, backendSessionId: string | undefined) =>
      params.runtime(session).setBackendSessionId(backendSessionId),
    getMessageHistory: (session: Session) => params.runtime(session).getMessageHistory(),
    setMessageHistory: (session: Session, history: Session["messageHistory"]) =>
      params.runtime(session).setMessageHistory(history),
    getLastStatus: (session: Session) => params.runtime(session).getLastStatus(),
    setLastStatus: (session: Session, status: Session["lastStatus"]) =>
      params.runtime(session).setLastStatus(status),
    storePendingPermission: (session: Session, requestId: string, request) =>
      params.runtime(session).storePendingPermission(requestId, request),
    clearDynamicSlashRegistry: (session: Session) =>
      params.runtime(session).clearDynamicSlashRegistry(),
    registerCLICommands: (session: Session, commands) =>
      params.runtime(session).registerCLICommands(commands),
    registerSkillCommands: (session: Session, skills: string[]) =>
      params.runtime(session).registerSkillCommands(skills),
  };
}

export function createBackendConnectorDeps(params: {
  adapter: BackendAdapter | null;
  adapterResolver: AdapterResolver | null;
  logger: Logger;
  metrics: MetricsCollector | null;
  broadcaster: ConsumerBroadcaster;
  routeUnifiedMessage: (session: Session, msg: UnifiedMessage) => void;
  emitEvent: EmitBridgeEvent;
  runtime: (session: Session) => SessionRuntime;
  tracer: MessageTracer;
}): BackendConnectorDeps {
  return {
    adapter: params.adapter,
    adapterResolver: params.adapterResolver,
    logger: params.logger,
    metrics: params.metrics,
    broadcaster: params.broadcaster,
    routeUnifiedMessage: params.routeUnifiedMessage,
    emitEvent: params.emitEvent,
    onBackendConnectedState: (session: Session, connectedParams) =>
      params.runtime(session).attachBackendConnection(connectedParams),
    onBackendDisconnectedState: (session: Session) =>
      params.runtime(session).resetBackendConnectionState(),
    getBackendSession: (session: Session) => params.runtime(session).getBackendSession(),
    getBackendAbort: (session: Session) => params.runtime(session).getBackendAbort(),
    drainPendingMessages: (session: Session) => params.runtime(session).drainPendingMessages(),
    drainPendingPermissionIds: (session: Session) =>
      params.runtime(session).drainPendingPermissionIds(),
    peekPendingPassthrough: (session: Session) => params.runtime(session).peekPendingPassthrough(),
    shiftPendingPassthrough: (session: Session) =>
      params.runtime(session).shiftPendingPassthrough(),
    setSlashCommandsState: (session: Session, commands: string[]) => {
      const runtime = params.runtime(session);
      runtime.setState({ ...runtime.getState(), slash_commands: commands });
    },
    registerCLICommands: (session: Session, commands: string[]) =>
      params.runtime(session).registerSlashCommandNames(commands),
    tracer: params.tracer,
  };
}

export function createConsumerGatewayDeps(params: {
  store: SessionRepository;
  gatekeeper: ConsumerGatekeeper;
  broadcaster: ConsumerBroadcaster;
  gitTracker: GitInfoTracker;
  logger: Logger;
  metrics: MetricsCollector | null;
  emit: ConsumerGatewayDeps["emit"];
  routeConsumerMessage: (session: Session, msg: InboundCommand, ws: WebSocketLike) => void;
  maxConsumerMessageSize: number;
  tracer: MessageTracer;
  runtime: (session: Session) => SessionRuntime;
}): ConsumerGatewayDeps {
  return {
    sessions: { get: (sessionId: string) => params.store.get(sessionId) },
    gatekeeper: params.gatekeeper,
    broadcaster: params.broadcaster,
    gitTracker: params.gitTracker,
    logger: params.logger,
    metrics: params.metrics,
    emit: params.emit,
    allocateAnonymousIdentityIndex: (session: Session) =>
      params.runtime(session).allocateAnonymousIdentityIndex(),
    checkRateLimit: (session: Session, ws: WebSocketLike) =>
      params.runtime(session).checkRateLimit(ws, () => params.gatekeeper.createRateLimiter()),
    getConsumerIdentity: (session: Session, ws: WebSocketLike) =>
      params.runtime(session).getConsumerIdentity(ws),
    getConsumerCount: (session: Session) => params.runtime(session).getConsumerCount(),
    getState: (session: Session) => params.runtime(session).getState(),
    getMessageHistory: (session: Session) => params.runtime(session).getMessageHistory(),
    getPendingPermissions: (session: Session) => params.runtime(session).getPendingPermissions(),
    getQueuedMessage: (session: Session) => params.runtime(session).getQueuedMessage(),
    isBackendConnected: (session: Session) => params.runtime(session).isBackendConnected(),
    registerConsumer: (session: Session, ws: WebSocketLike, identity) =>
      params.runtime(session).addConsumer(ws, identity),
    unregisterConsumer: (session: Session, ws: WebSocketLike) =>
      params.runtime(session).removeConsumer(ws),
    routeConsumerMessage: params.routeConsumerMessage,
    maxConsumerMessageSize: params.maxConsumerMessageSize,
    tracer: params.tracer,
  };
}
