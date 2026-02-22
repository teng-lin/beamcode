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
import {
  generateSlashRequestId,
  generateTraceId,
  tracedNormalizeInbound,
} from "./bridge/message-tracing-utils.js";
import { RuntimeManager } from "./bridge/runtime-manager.js";
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
import { SessionRuntime } from "./session-runtime.js";
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
    const emitEvent = this.forwardEvent.bind(this);

    // ── RuntimeManager (lazy SessionRuntime factory) ────────────────────
    this.runtimeManager = new RuntimeManager(
      (session) =>
        new SessionRuntime(session, {
          now: () => Date.now(),
          maxMessageHistoryLength: this.config.maxMessageHistoryLength,
          broadcaster: this.broadcaster,
          queueHandler: this.queueHandler,
          slashService: this.slashService,
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
        }),
    );

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
      {
        getState: (session) => this.runtime(session).getState(),
        setState: (session, state) => this.runtime(session).setState(state),
        getPendingInitialize: (session) => this.runtime(session).getPendingInitialize(),
        setPendingInitialize: (session, pendingInitialize) =>
          this.runtime(session).setPendingInitialize(pendingInitialize),
        trySendRawToBackend: (session, ndjson) => this.runtime(session).trySendRawToBackend(ndjson),
        registerCLICommands: (session, commands) =>
          this.runtime(session).registerCLICommands(commands),
      },
    );
    this.queueHandler = new MessageQueueHandler(
      this.broadcaster,
      (sessionId, content, opts) => this.sendUserMessage(sessionId, content, opts),
      {
        getLastStatus: (session) => this.runtime(session).getLastStatus(),
        setLastStatus: (session, status) => this.runtime(session).setLastStatus(status),
        getQueuedMessage: (session) => this.runtime(session).getQueuedMessage(),
        setQueuedMessage: (session, queued) => this.runtime(session).setQueuedMessage(queued),
        getConsumerIdentity: (session, ws) => this.runtime(session).getConsumerIdentity(ws),
      },
    );

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
    this.messageRouter = new UnifiedMessageRouter({
      broadcaster: this.broadcaster,
      capabilitiesPolicy: this.capabilitiesPolicy,
      queueHandler: this.queueHandler,
      gitTracker: this.gitTracker,
      gitResolver: this.gitResolver,
      emitEvent,
      persistSession: (session) => this.persistSession(session),
      maxMessageHistoryLength: this.config.maxMessageHistoryLength,
      tracer: this.tracer,
      getState: (session) => this.runtime(session).getState(),
      setState: (session, state) => this.runtime(session).setState(state),
      setBackendSessionId: (session, backendSessionId) =>
        this.runtime(session).setBackendSessionId(backendSessionId),
      getMessageHistory: (session) => this.runtime(session).getMessageHistory(),
      setMessageHistory: (session, history) => this.runtime(session).setMessageHistory(history),
      getLastStatus: (session) => this.runtime(session).getLastStatus(),
      setLastStatus: (session, status) => this.runtime(session).setLastStatus(status),
      storePendingPermission: (session, requestId, request) =>
        this.runtime(session).storePendingPermission(requestId, request),
      clearDynamicSlashRegistry: (session) => this.runtime(session).clearDynamicSlashRegistry(),
      registerCLICommands: (session, commands) =>
        this.runtime(session).registerCLICommands(commands),
      registerSkillCommands: (session, skills) =>
        this.runtime(session).registerSkillCommands(skills),
    });

    // ── BackendPlane ────────────────────────────────────────────────────
    this.backendConnector = new BackendConnector({
      adapter: options?.adapter ?? null,
      adapterResolver: options?.adapterResolver ?? null,
      logger: this.logger,
      metrics: this.metrics,
      broadcaster: this.broadcaster,
      routeUnifiedMessage: (session, msg) => this.routeUnifiedMessage(session, msg),
      emitEvent,
      onBackendConnectedState: (session, params) =>
        this.runtime(session).attachBackendConnection(params),
      onBackendDisconnectedState: (session) => this.runtime(session).resetBackendConnectionState(),
      getBackendSession: (session) => this.runtime(session).getBackendSession(),
      getBackendAbort: (session) => this.runtime(session).getBackendAbort(),
      drainPendingMessages: (session) => this.runtime(session).drainPendingMessages(),
      drainPendingPermissionIds: (session) => this.runtime(session).drainPendingPermissionIds(),
      peekPendingPassthrough: (session) => this.runtime(session).peekPendingPassthrough(),
      shiftPendingPassthrough: (session) => this.runtime(session).shiftPendingPassthrough(),
      setSlashCommandsState: (session, commands) => {
        const runtime = this.runtime(session);
        runtime.setState({ ...runtime.getState(), slash_commands: commands });
      },
      registerCLICommands: (session, commands) =>
        this.runtime(session).registerSlashCommandNames(commands),
      tracer: this.tracer,
    });

    // ── ConsumerGateway (WebSocket accept/reject/route) ─────────────────
    this.consumerGateway = new ConsumerGateway({
      sessions: { get: (sessionId) => this.store.get(sessionId) },
      gatekeeper: this.gatekeeper,
      broadcaster: this.broadcaster,
      gitTracker: this.gitTracker,
      logger: this.logger,
      metrics: this.metrics,
      emit: this.forwardBridgeEvent.bind(this),
      allocateAnonymousIdentityIndex: (session) =>
        this.runtime(session).allocateAnonymousIdentityIndex(),
      checkRateLimit: (session, ws) =>
        this.runtime(session).checkRateLimit(ws, () => this.gatekeeper.createRateLimiter()),
      getConsumerIdentity: (session, ws) => this.runtime(session).getConsumerIdentity(ws),
      getConsumerCount: (session) => this.runtime(session).getConsumerCount(),
      getState: (session) => this.runtime(session).getState(),
      getMessageHistory: (session) => this.runtime(session).getMessageHistory(),
      getPendingPermissions: (session) => this.runtime(session).getPendingPermissions(),
      getQueuedMessage: (session) => this.runtime(session).getQueuedMessage(),
      isBackendConnected: (session) => this.runtime(session).isBackendConnected(),
      registerConsumer: (session, ws, identity) => this.runtime(session).addConsumer(ws, identity),
      unregisterConsumer: (session, ws) => this.runtime(session).removeConsumer(ws),
      routeConsumerMessage: (session, msg, ws) => this.routeConsumerMessage(session, msg, ws),
      maxConsumerMessageSize: MAX_CONSUMER_MESSAGE_SIZE,
      tracer: this.tracer,
    });
  }

  // ── Event forwarding ─────────────────────────────────────────────────────

  getLifecycleState(sessionId: string): LifecycleState | undefined {
    return this.runtimeManager.getLifecycleState(sessionId);
  }

  private routeUnifiedMessage(session: Session, msg: UnifiedMessage): void {
    this.runtime(session).handleBackendMessage(msg);
  }

  /** Forward a typed event from a delegate to the bridge's event emitter. */
  private forwardEvent(type: string, payload: unknown): void {
    if (payload && typeof payload === "object" && "sessionId" in payload) {
      const sessionId = (payload as { sessionId?: unknown }).sessionId;
      if (
        typeof sessionId === "string" &&
        (type === "backend:connected" ||
          type === "backend:disconnected" ||
          type === "session:closed")
      ) {
        this.runtimeManager.handleLifecycleSignal(sessionId, type);
      }
    }
    this.emit(type as keyof BridgeEventMap, payload as BridgeEventMap[keyof BridgeEventMap]);
  }

  private forwardBridgeEvent<K extends keyof BridgeEventMap>(
    type: K,
    payload: BridgeEventMap[K],
  ): void {
    this.emit(type, payload);
  }

  private runtime(session: Session): SessionRuntime {
    return this.runtimeManager.getOrCreate(session);
  }

  private withSession<T>(sessionId: string, onMissing: T, run: (session: Session) => T): T {
    const session = this.store.get(sessionId);
    if (!session) return onMissing;
    return run(session);
  }

  private withSessionVoid(sessionId: string, run: (session: Session) => void): void {
    const session = this.store.get(sessionId);
    if (!session) return;
    run(session);
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
    const existed = this.store.has(sessionId);
    const session = this.store.getOrCreate(sessionId);
    this.runtime(session);
    if (!existed) {
      this.metrics?.recordEvent({
        timestamp: Date.now(),
        type: "session:created",
        sessionId,
      });
    }
    return session;
  }

  /** Set the adapter name for a session (persisted for restore). */
  setAdapterName(sessionId: string, name: string): void {
    const session = this.getOrCreateSession(sessionId);
    this.runtime(session).setAdapterName(name);
  }

  /**
   * Seed a session's state with known launch parameters (cwd, model, etc.)
   * and eagerly resolve git info. Call this right after launcher.launch()
   * so consumers connecting before the CLI's system.init see useful state.
   */
  seedSessionState(sessionId: string, params: { cwd?: string; model?: string }): void {
    const session = this.getOrCreateSession(sessionId);
    this.runtime(session).seedSessionState(params);
  }

  /** Get a read-only snapshot of a session's state. */
  getSession(sessionId: string): SessionSnapshot | undefined {
    return this.withSession(sessionId, undefined, (session) =>
      this.runtime(session).getSessionSnapshot(),
    );
  }

  getAllSessions(): SessionState[] {
    return this.store.getAllStates();
  }

  isCliConnected(sessionId: string): boolean {
    return this.withSession(sessionId, false, (session) =>
      this.runtime(session).isBackendConnected(),
    );
  }

  /** Expose storage for archival operations (BridgeOperations interface). */
  get storage(): SessionStorage | null {
    return this.store.getStorage();
  }

  removeSession(sessionId: string): void {
    const session = this.store.get(sessionId);
    if (session) {
      this.capabilitiesPolicy.cancelPendingInitialize(session);
    }
    this.runtimeManager.delete(sessionId);
    this.store.remove(sessionId);
  }

  /** Close all sockets (CLI + consumers) and backend sessions, then remove. */
  async closeSession(sessionId: string): Promise<void> {
    const session = this.store.get(sessionId);
    if (!session) return;
    const runtime = this.runtime(session);
    runtime.transitionLifecycle("closing", "session:close");

    this.capabilitiesPolicy.cancelPendingInitialize(session);

    // Close backend session and await it so the subprocess is fully terminated
    // before the caller proceeds (prevents port-reuse races in sequential tests).
    if (runtime.getBackendSession()) {
      await runtime.closeBackendConnection().catch((err) => {
        this.logger.warn("Failed to close backend session", { sessionId: session.id, error: err });
      });
    }

    runtime.closeAllConsumers();
    runtime.handleSignal("session:closed");

    this.store.remove(sessionId);
    this.runtimeManager.delete(sessionId);
    this.metrics?.recordEvent({
      timestamp: Date.now(),
      type: "session:closed",
      sessionId,
    });
    this.emit("session:closed", { sessionId });
  }

  /** Close all sessions and clear all state (for graceful shutdown). */
  async close(): Promise<void> {
    await Promise.allSettled(Array.from(this.store.keys()).map((id) => this.closeSession(id)));
    this.runtimeManager.clear();
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
    this.withSessionVoid(sessionId, (session) =>
      this.runtime(session).sendUserMessage(content, options),
    );
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
    this.withSessionVoid(sessionId, (session) =>
      this.runtime(session).sendPermissionResponse(requestId, behavior, options),
    );
  }

  /** Send an interrupt to the CLI for a session. */
  sendInterrupt(sessionId: string): void {
    this.withSessionVoid(sessionId, (session) => this.runtime(session).sendInterrupt());
  }

  /** Send a set_model control request to the CLI. */
  sendSetModel(sessionId: string, model: string): void {
    this.withSessionVoid(sessionId, (session) => this.runtime(session).sendSetModel(model));
  }

  /** Send a set_permission_mode control request to the CLI. */
  sendSetPermissionMode(sessionId: string, mode: string): void {
    this.withSessionVoid(sessionId, (session) => this.runtime(session).sendSetPermissionMode(mode));
  }

  // ── Structured data APIs ───────────────────────────────────────────────

  getSupportedModels(sessionId: string): InitializeModel[] {
    return this.withSession(sessionId, [] as InitializeModel[], (session) =>
      this.runtime(session).getSupportedModels(),
    );
  }

  getSupportedCommands(sessionId: string): InitializeCommand[] {
    return this.withSession(sessionId, [] as InitializeCommand[], (session) =>
      this.runtime(session).getSupportedCommands(),
    );
  }

  getAccountInfo(sessionId: string): InitializeAccount | null {
    return this.withSession(sessionId, null, (session) => this.runtime(session).getAccountInfo());
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
    return this.withSession(sessionId, null, (session) =>
      this.runtime(session).executeSlashCommand(command),
    );
  }

  /** Push a session name update to all connected consumers for a session. */
  broadcastNameUpdate(sessionId: string, name: string): void {
    this.withSessionVoid(sessionId, (session) =>
      this.broadcaster.broadcastNameUpdate(session, name),
    );
  }

  /** Broadcast resume_failed to all consumers for a session. */
  broadcastResumeFailedToConsumers(sessionId: string): void {
    this.withSessionVoid(sessionId, (session) =>
      this.broadcaster.broadcastResumeFailed(session, sessionId),
    );
  }

  /** Broadcast process output to participants only (observers must not see process logs). */
  broadcastProcessOutput(sessionId: string, stream: "stdout" | "stderr", data: string): void {
    this.withSessionVoid(sessionId, (session) =>
      this.broadcaster.broadcastProcessOutput(session, stream, data),
    );
  }

  /** Broadcast watchdog state update via session_update. */
  broadcastWatchdogState(
    sessionId: string,
    watchdog: { gracePeriodMs: number; startedAt: number } | null,
  ): void {
    this.withSessionVoid(sessionId, (session) =>
      this.broadcaster.broadcastWatchdogState(session, watchdog),
    );
  }

  /** Broadcast circuit breaker state update via session_update. */
  broadcastCircuitBreakerState(
    sessionId: string,
    circuitBreaker: { state: string; failureCount: number; recoveryTimeRemainingMs: number },
  ): void {
    this.withSessionVoid(sessionId, (session) =>
      this.broadcaster.broadcastCircuitBreakerState(session, circuitBreaker),
    );
  }

  applyPolicyCommand(sessionId: string, command: PolicyCommand): void {
    this.withSessionVoid(sessionId, (session) =>
      this.runtime(session).handlePolicyCommand(command),
    );
  }

  // ── BackendAdapter path (delegated to BackendConnector) ──────────

  /** Whether a BackendAdapter is configured. */
  get hasAdapter(): boolean {
    return this.backendConnector.hasAdapter;
  }

  /** Connect a session via BackendAdapter and start consuming messages. */
  async connectBackend(
    sessionId: string,
    options?: { resume?: boolean; adapterOptions?: Record<string, unknown> },
  ): Promise<void> {
    const session = this.getOrCreateSession(sessionId);
    return this.backendConnector.connectBackend(session, options);
  }

  /** Disconnect the backend session. */
  async disconnectBackend(sessionId: string): Promise<void> {
    return this.withSession(sessionId, undefined, (session) => {
      this.capabilitiesPolicy.cancelPendingInitialize(session);
      return this.backendConnector.disconnectBackend(session);
    });
  }

  /** Whether a backend session is connected for a given session ID. */
  isBackendConnected(sessionId: string): boolean {
    return this.withSession(sessionId, false, (session) =>
      this.backendConnector.isBackendConnected(session),
    );
  }

  /** Send a UnifiedMessage to the backend session. */
  sendToBackend(sessionId: string, message: UnifiedMessage): void {
    const session = this.store.get(sessionId);
    if (!session) {
      this.logger.warn(`No backend session for ${sessionId}, cannot send message`);
      return;
    }
    this.runtime(session).sendToBackend(message);
  }
}
