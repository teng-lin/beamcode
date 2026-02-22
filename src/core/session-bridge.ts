/**
 * SessionBridge — central orchestrator that wires all four bounded contexts together.
 *
 * Owns the session lifecycle and delegates to specialized components:
 * - **ConsumerPlane**: ConsumerGateway, ConsumerGatekeeper, ConsumerBroadcaster
 * - **BackendPlane**: BackendConnector
 * - **MessagePlane**: UnifiedMessageRouter, ConsumerMessageMapper, InboundNormalizer
 * - **SessionControl**: CapabilitiesPolicy, GitInfoTracker, SessionRepository
 *
 * Delegates runtime ownership to RuntimeManager.
 *
 * @module SessionControl
 */

import type { AuthContext, Authenticator } from "../interfaces/auth.js";
import type { GitInfoResolver } from "../interfaces/git-resolver.js";
import type { Logger } from "../interfaces/logger.js";
import type { MetricsCollector } from "../interfaces/metrics.js";
import type { SessionStorage } from "../interfaces/storage.js";
import type { WebSocketLike } from "../interfaces/transport.js";
import type {
  InitializeAccount,
  InitializeCommand,
  InitializeModel,
} from "../types/cli-messages.js";
import type { ProviderConfig, ResolvedConfig } from "../types/config.js";
import { resolveConfig } from "../types/config.js";
import type { BridgeEventMap } from "../types/events.js";
import type { SessionSnapshot, SessionState } from "../types/session-state.js";
import { noopLogger } from "../utils/noop-logger.js";
import { BackendConnector } from "./backend-connector.js";
import { BackendApi } from "./bridge/backend-api.js";
import { forwardBridgeEventWithLifecycle } from "./bridge/bridge-event-forwarder.js";
import {
  generateSlashRequestId,
  generateTraceId,
  tracedNormalizeInbound,
} from "./bridge/message-tracing-utils.js";
import { RuntimeApi } from "./bridge/runtime-api.js";
import type { RuntimeManager } from "./bridge/runtime-manager.js";
import { createRuntimeManager } from "./bridge/runtime-manager-factory.js";
import {
  createBackendConnectorDeps,
  createCapabilitiesPolicyStateAccessors,
  createConsumerGatewayDeps,
  createQueueStateAccessors,
  createUnifiedMessageRouterDeps,
} from "./bridge/session-bridge-deps-factory.js";
import { SessionBroadcastApi } from "./bridge/session-broadcast-api.js";
import { SessionInfoApi } from "./bridge/session-info-api.js";
import { SessionLifecycleService } from "./bridge/session-lifecycle-service.js";
import { createSlashService } from "./bridge/slash-service-factory.js";
import { CapabilitiesPolicy } from "./capabilities-policy.js";
import { ConsumerBroadcaster, MAX_CONSUMER_MESSAGE_SIZE } from "./consumer-broadcaster.js";
import { ConsumerGatekeeper, type RateLimiterFactory } from "./consumer-gatekeeper.js";
import { ConsumerGateway } from "./consumer-gateway.js";
import { GitInfoTracker } from "./git-info-tracker.js";
import type { AdapterResolver } from "./interfaces/adapter-resolver.js";
import type { BackendAdapter } from "./interfaces/backend-adapter.js";
import type { InboundCommand, PolicyCommand } from "./interfaces/runtime-commands.js";
import { MessageQueueHandler } from "./message-queue-handler.js";
import { type MessageTracer, noopTracer } from "./message-tracer.js";
import type { LifecycleState } from "./session-lifecycle.js";
import { type Session, SessionRepository } from "./session-repository.js";
import type { SessionRuntime } from "./session-runtime.js";
import { SlashCommandRegistry } from "./slash-command-registry.js";
import type { SlashCommandService } from "./slash-command-service.js";
import { TeamToolCorrelationBuffer } from "./team-tool-correlation.js";
import { TypedEventEmitter } from "./typed-emitter.js";
import type { UnifiedMessage } from "./types/unified-message.js";
import { UnifiedMessageRouter } from "./unified-message-router.js";

// ─── SessionBridge ───────────────────────────────────────────────────────────

export class SessionBridge extends TypedEventEmitter<BridgeEventMap> {
  private store: SessionRepository;
  private broadcaster: ConsumerBroadcaster;
  private gatekeeper: ConsumerGatekeeper;
  private gitResolver: GitInfoResolver | null;
  private gitTracker: GitInfoTracker;
  private logger: Logger;
  private config: ResolvedConfig;
  private metrics: MetricsCollector | null;
  private slashService: SlashCommandService;
  private queueHandler: MessageQueueHandler;
  private capabilitiesPolicy: CapabilitiesPolicy;
  private backendConnector: BackendConnector;
  private messageRouter: UnifiedMessageRouter;
  private consumerGateway: ConsumerGateway;
  private tracer: MessageTracer;
  private runtimeManager: RuntimeManager;
  private lifecycleService: SessionLifecycleService;
  private runtimeApi: RuntimeApi;
  private broadcastApi: SessionBroadcastApi;
  private backendApi!: BackendApi;
  private infoApi!: SessionInfoApi;

  constructor(options?: {
    storage?: SessionStorage;
    gitResolver?: GitInfoResolver;
    authenticator?: Authenticator;
    logger?: Logger;
    config?: ProviderConfig;
    metrics?: MetricsCollector;
    /** BackendAdapter for adapter-based sessions (coexistence with CLI WebSocket path). */
    adapter?: BackendAdapter;
    /** Per-session adapter resolver (resolves adapter by name). */
    adapterResolver?: AdapterResolver;
    /** Factory for creating rate limiters (injected from outside core). */
    rateLimiterFactory?: RateLimiterFactory;
    /** Message tracer for debug tracing. */
    tracer?: MessageTracer;
  }) {
    super();

    // ── Core infrastructure ─────────────────────────────────────────────
    this.store = new SessionRepository(options?.storage ?? null, {
      createCorrelationBuffer: () => new TeamToolCorrelationBuffer(),
      createRegistry: () => new SlashCommandRegistry(),
    });
    this.logger = options?.logger ?? noopLogger;
    this.config = resolveConfig(options?.config ?? { port: 9414 });
    this.tracer = options?.tracer ?? noopTracer;
    this.gitResolver = options?.gitResolver ?? null;
    this.metrics = options?.metrics ?? null;
    const emitEvent = (type: string, payload: unknown) =>
      forwardBridgeEventWithLifecycle(
        this.runtimeManager,
        (eventType, eventPayload) =>
          this.emit(
            eventType as keyof BridgeEventMap,
            eventPayload as BridgeEventMap[keyof BridgeEventMap],
          ),
        type,
        payload,
      );

    // ── RuntimeManager (lazy SessionRuntime factory) ────────────────────
    this.runtimeManager = createRuntimeManager({
      now: () => Date.now(),
      maxMessageHistoryLength: this.config.maxMessageHistoryLength,
      getBroadcaster: () => this.broadcaster,
      getQueueHandler: () => this.queueHandler,
      getSlashService: () => this.slashService,
      sendToBackend: (runtimeSession, message) =>
        this.backendConnector.sendToBackend(runtimeSession, message),
      tracedNormalizeInbound: (runtimeSession, inbound, trace) =>
        tracedNormalizeInbound(this.tracer, inbound, runtimeSession.id, trace),
      persistSession: (runtimeSession) => this.persistSession(runtimeSession),
      warnUnknownPermission: (sessionId, requestId) =>
        this.logger.warn(
          `Permission response for unknown request_id ${requestId} in session ${sessionId}`,
        ),
      emitPermissionResolved: (sessionId, requestId, behavior) =>
        this.emit("permission:resolved", { sessionId, requestId, behavior }),
      onSessionSeeded: (runtimeSession) => this.gitTracker.resolveGitInfo(runtimeSession),
      onInvalidLifecycleTransition: ({ sessionId, from, to, reason }) =>
        this.logger.warn("Session lifecycle invalid transition", {
          sessionId,
          current: from,
          next: to,
          reason,
        }),
      routeBackendMessage: (runtimeSession, unified) =>
        this.messageRouter.route(runtimeSession, unified),
    });
    this.runtimeApi = new RuntimeApi({
      store: this.store,
      runtimeManager: this.runtimeManager,
      logger: this.logger,
    });
    this.infoApi = new SessionInfoApi({
      store: this.store,
      runtimeManager: this.runtimeManager,
      getOrCreateSession: (sessionId) => this.getOrCreateSession(sessionId),
    });

    // ── ConsumerPlane ───────────────────────────────────────────────────
    this.broadcaster = new ConsumerBroadcaster(
      this.logger,
      (sessionId, msg) => this.emit("message:outbound", { sessionId, message: msg }),
      this.tracer,
      (session, ws) => this.runtime(session).removeConsumer(ws),
      {
        getConsumerSockets: (session) => this.runtime(session).getConsumerSockets(),
      },
    );
    this.broadcastApi = new SessionBroadcastApi({
      store: this.store,
      broadcaster: this.broadcaster,
    });
    this.gatekeeper = new ConsumerGatekeeper(
      options?.authenticator ?? null,
      this.config,
      options?.rateLimiterFactory,
    );
    this.gitTracker = new GitInfoTracker(this.gitResolver, {
      getState: (session) => this.runtime(session).getState(),
      setState: (session, state) => this.runtime(session).setState(state),
    });

    // ── SessionControl (capabilities + queue) ───────────────────────────
    this.capabilitiesPolicy = new CapabilitiesPolicy(
      this.config,
      this.logger,
      this.broadcaster,
      emitEvent,
      (session) => this.persistSession(session),
      createCapabilitiesPolicyStateAccessors((session) => this.runtime(session)),
    );
    this.queueHandler = new MessageQueueHandler(
      this.broadcaster,
      (sessionId, content, opts) => this.sendUserMessage(sessionId, content, opts),
      createQueueStateAccessors((session) => this.runtime(session)),
    );
    this.lifecycleService = new SessionLifecycleService({
      store: this.store,
      runtimeManager: this.runtimeManager,
      capabilitiesPolicy: this.capabilitiesPolicy,
      metrics: this.metrics,
      logger: this.logger,
      emitSessionClosed: (sessionId) => this.emit("session:closed", { sessionId }),
    });

    // ── MessagePlane (slash commands + routing) ─────────────────────────
    this.slashService = createSlashService({
      broadcaster: this.broadcaster,
      emitEvent,
      tracer: this.tracer,
      now: () => Date.now(),
      generateTraceId: () => generateTraceId(),
      generateSlashRequestId: () => generateSlashRequestId(),
      registerPendingPassthrough: (session, entry) =>
        this.runtime(session).enqueuePendingPassthrough(entry),
      sendUserMessage: (sessionId, content, trace) =>
        this.sendUserMessage(sessionId, content, {
          traceId: trace?.traceId,
          slashRequestId: trace?.requestId,
          slashCommand: trace?.command,
        }),
    });
    this.messageRouter = new UnifiedMessageRouter(
      createUnifiedMessageRouterDeps({
        broadcaster: this.broadcaster,
        capabilitiesPolicy: this.capabilitiesPolicy,
        queueHandler: this.queueHandler,
        gitTracker: this.gitTracker,
        gitResolver: this.gitResolver,
        emitEvent,
        persistSession: (session) => this.persistSession(session),
        maxMessageHistoryLength: this.config.maxMessageHistoryLength,
        tracer: this.tracer,
        runtime: (session) => this.runtime(session),
      }),
    );

    // ── BackendPlane ────────────────────────────────────────────────────
    this.backendConnector = new BackendConnector(
      createBackendConnectorDeps({
        adapter: options?.adapter ?? null,
        adapterResolver: options?.adapterResolver ?? null,
        logger: this.logger,
        metrics: this.metrics,
        broadcaster: this.broadcaster,
        routeUnifiedMessage: (session, msg) => this.runtime(session).handleBackendMessage(msg),
        emitEvent,
        runtime: (session) => this.runtime(session),
        tracer: this.tracer,
      }),
    );
    this.backendApi = new BackendApi({
      store: this.store,
      backendConnector: this.backendConnector,
      capabilitiesPolicy: this.capabilitiesPolicy,
      getOrCreateSession: (sessionId) => this.getOrCreateSession(sessionId),
    });

    // ── ConsumerGateway (WebSocket accept/reject/route) ─────────────────
    this.consumerGateway = new ConsumerGateway(
      createConsumerGatewayDeps({
        store: this.store,
        gatekeeper: this.gatekeeper,
        broadcaster: this.broadcaster,
        gitTracker: this.gitTracker,
        logger: this.logger,
        metrics: this.metrics,
        emit: (type, payload) => this.emit(type, payload),
        routeConsumerMessage: (session, msg, ws) => this.routeConsumerMessage(session, msg, ws),
        maxConsumerMessageSize: MAX_CONSUMER_MESSAGE_SIZE,
        tracer: this.tracer,
        runtime: (session) => this.runtime(session),
      }),
    );
  }

  // ── Event forwarding ─────────────────────────────────────────────────────

  getLifecycleState(sessionId: string): LifecycleState | undefined {
    return this.runtimeManager.getLifecycleState(sessionId);
  }

  private runtime(session: Session): SessionRuntime {
    return this.runtimeManager.getOrCreate(session);
  }

  // ── Persistence ──────────────────────────────────────────────────────────

  /** Restore sessions from disk (call once at startup). */
  restoreFromStorage(): number {
    const count = this.store.restoreAll();
    if (count > 0) {
      this.logger.info(`Restored ${count} session(s) from disk`);
    }
    return count;
  }

  /** Persist a session to disk. */
  private persistSession(session: Session): void {
    this.store.persist(session);
  }

  // ── Session management ───────────────────────────────────────────────────

  getOrCreateSession(sessionId: string): Session {
    return this.lifecycleService.getOrCreateSession(sessionId);
  }

  /** Set the adapter name for a session (persisted for restore). */
  setAdapterName(sessionId: string, name: string): void {
    this.infoApi.setAdapterName(sessionId, name);
  }

  /**
   * Seed a session's state with known launch parameters (cwd, model, etc.)
   * and eagerly resolve git info. Call this right after launcher.launch()
   * so consumers connecting before the CLI's system.init see useful state.
   */
  seedSessionState(sessionId: string, params: { cwd?: string; model?: string }): void {
    this.infoApi.seedSessionState(sessionId, params);
  }

  /** Get a read-only snapshot of a session's state. */
  getSession(sessionId: string): SessionSnapshot | undefined {
    return this.infoApi.getSession(sessionId);
  }

  getAllSessions(): SessionState[] {
    return this.infoApi.getAllSessions();
  }

  isCliConnected(sessionId: string): boolean {
    return this.infoApi.isCliConnected(sessionId);
  }

  /** Expose storage for archival operations (BridgeOperations interface). */
  get storage(): SessionStorage | null {
    return this.infoApi.getStorage();
  }

  removeSession(sessionId: string): void {
    this.lifecycleService.removeSession(sessionId);
  }

  /** Close all sockets (CLI + consumers) and backend sessions, then remove. */
  async closeSession(sessionId: string): Promise<void> {
    return this.lifecycleService.closeSession(sessionId);
  }

  /** Close all sessions and clear all state (for graceful shutdown). */
  async close(): Promise<void> {
    await this.lifecycleService.closeAllSessions();
    this.tracer.destroy();
    this.removeAllListeners();
  }

  // ── Consumer WebSocket handlers ──────────────────────────────────────────

  handleConsumerOpen(ws: WebSocketLike, context: AuthContext): void {
    this.consumerGateway.handleConsumerOpen(ws, context);
  }

  handleConsumerMessage(ws: WebSocketLike, sessionId: string, data: string | Buffer): void {
    this.consumerGateway.handleConsumerMessage(ws, sessionId, data);
  }

  handleConsumerClose(ws: WebSocketLike, sessionId: string): void {
    this.consumerGateway.handleConsumerClose(ws, sessionId);
  }

  // ── Programmatic API ─────────────────────────────────────────────────────

  /** Send a user message to the CLI for a session (no WebSocket needed). */
  sendUserMessage(
    sessionId: string,
    content: string,
    options?: {
      sessionIdOverride?: string;
      images?: { media_type: string; data: string }[];
      traceId?: string;
      slashRequestId?: string;
      slashCommand?: string;
    },
  ): void {
    this.runtimeApi.sendUserMessage(sessionId, content, options);
  }

  /** Respond to a pending permission request (no WebSocket needed). */
  sendPermissionResponse(
    sessionId: string,
    requestId: string,
    behavior: "allow" | "deny",
    options?: {
      updatedInput?: Record<string, unknown>;
      updatedPermissions?: unknown[];
      message?: string;
    },
  ): void {
    this.runtimeApi.sendPermissionResponse(sessionId, requestId, behavior, options);
  }

  /** Send an interrupt to the CLI for a session. */
  sendInterrupt(sessionId: string): void {
    this.runtimeApi.sendInterrupt(sessionId);
  }

  /** Send a set_model control request to the CLI. */
  sendSetModel(sessionId: string, model: string): void {
    this.runtimeApi.sendSetModel(sessionId, model);
  }

  /** Send a set_permission_mode control request to the CLI. */
  sendSetPermissionMode(sessionId: string, mode: string): void {
    this.runtimeApi.sendSetPermissionMode(sessionId, mode);
  }

  // ── Structured data APIs ───────────────────────────────────────────────

  getSupportedModels(sessionId: string): InitializeModel[] {
    return this.runtimeApi.getSupportedModels(sessionId);
  }

  getSupportedCommands(sessionId: string): InitializeCommand[] {
    return this.runtimeApi.getSupportedCommands(sessionId);
  }

  getAccountInfo(sessionId: string): InitializeAccount | null {
    return this.runtimeApi.getAccountInfo(sessionId);
  }

  // ── Consumer message routing ─────────────────────────────────────────────

  private routeConsumerMessage(session: Session, msg: InboundCommand, ws: WebSocketLike): void {
    this.runtime(session).handleInboundCommand(msg, ws);
  }

  // ── Slash command handling (delegated via SessionRuntime -> SlashCommandService) ─────

  /** Execute a slash command programmatically (no WebSocket needed). */
  async executeSlashCommand(
    sessionId: string,
    command: string,
  ): Promise<{ content: string; source: "emulated" } | null> {
    return this.runtimeApi.executeSlashCommand(sessionId, command);
  }

  /** Push a session name update to all connected consumers for a session. */
  broadcastNameUpdate(sessionId: string, name: string): void {
    this.broadcastApi.broadcastNameUpdate(sessionId, name);
  }

  /** Broadcast resume_failed to all consumers for a session. */
  broadcastResumeFailedToConsumers(sessionId: string): void {
    this.broadcastApi.broadcastResumeFailedToConsumers(sessionId);
  }

  /** Broadcast process output to participants only (observers must not see process logs). */
  broadcastProcessOutput(sessionId: string, stream: "stdout" | "stderr", data: string): void {
    this.broadcastApi.broadcastProcessOutput(sessionId, stream, data);
  }

  /** Broadcast watchdog state update via session_update. */
  broadcastWatchdogState(
    sessionId: string,
    watchdog: { gracePeriodMs: number; startedAt: number } | null,
  ): void {
    this.broadcastApi.broadcastWatchdogState(sessionId, watchdog);
  }

  /** Broadcast circuit breaker state update via session_update. */
  broadcastCircuitBreakerState(
    sessionId: string,
    circuitBreaker: { state: string; failureCount: number; recoveryTimeRemainingMs: number },
  ): void {
    this.broadcastApi.broadcastCircuitBreakerState(sessionId, circuitBreaker);
  }

  applyPolicyCommand(sessionId: string, command: PolicyCommand): void {
    this.runtimeApi.applyPolicyCommand(sessionId, command);
  }

  // ── BackendAdapter path (delegated to BackendConnector) ──────────

  /** Whether a BackendAdapter is configured. */
  get hasAdapter(): boolean {
    return this.backendApi.hasAdapter;
  }

  /** Connect a session via BackendAdapter and start consuming messages. */
  async connectBackend(
    sessionId: string,
    options?: { resume?: boolean; adapterOptions?: Record<string, unknown> },
  ): Promise<void> {
    return this.backendApi.connectBackend(sessionId, options);
  }

  /** Disconnect the backend session. */
  async disconnectBackend(sessionId: string): Promise<void> {
    return this.backendApi.disconnectBackend(sessionId);
  }

  /** Whether a backend session is connected for a given session ID. */
  isBackendConnected(sessionId: string): boolean {
    return this.backendApi.isBackendConnected(sessionId);
  }

  /** Send a UnifiedMessage to the backend session. */
  sendToBackend(sessionId: string, message: UnifiedMessage): void {
    this.runtimeApi.sendToBackend(sessionId, message);
  }
}
