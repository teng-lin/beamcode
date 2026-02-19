import type { AdapterResolver } from "../adapters/adapter-resolver.js";
import { noopLogger } from "../adapters/noop-logger.js";
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
import type { ConsumerMessage } from "../types/consumer-messages.js";
import type { BridgeEventMap } from "../types/events.js";
import type { InboundMessage } from "../types/inbound-messages.js";
import type { SessionSnapshot, SessionState } from "../types/session-state.js";
import { BackendLifecycleManager } from "./backend-lifecycle-manager.js";
import { CapabilitiesProtocol } from "./capabilities-protocol.js";
import { ConsumerBroadcaster, MAX_CONSUMER_MESSAGE_SIZE } from "./consumer-broadcaster.js";
import { ConsumerGatekeeper, type RateLimiterFactory } from "./consumer-gatekeeper.js";
import { ConsumerTransportCoordinator } from "./consumer-transport-coordinator.js";
import { GitInfoTracker } from "./git-info-tracker.js";
import { normalizeInbound } from "./inbound-normalizer.js";
import type { BackendAdapter } from "./interfaces/backend-adapter.js";
import { MessageQueueHandler } from "./message-queue-handler.js";
import { type MessageTracer, noopTracer } from "./message-tracer.js";
import type { Session } from "./session-store.js";
import { SessionStore } from "./session-store.js";
import {
  AdapterNativeHandler,
  LocalHandler,
  PassthroughHandler,
  SlashCommandChain,
  UnsupportedHandler,
} from "./slash-command-chain.js";
import { SlashCommandExecutor } from "./slash-command-executor.js";
import { SlashCommandRegistry } from "./slash-command-registry.js";
import { TeamToolCorrelationBuffer } from "./team-tool-correlation.js";
import { TypedEventEmitter } from "./typed-emitter.js";
import type { UnifiedMessage } from "./types/unified-message.js";
import { UnifiedMessageRouter } from "./unified-message-router.js";

// ─── SessionBridge ───────────────────────────────────────────────────────────

export class SessionBridge extends TypedEventEmitter<BridgeEventMap> {
  private store: SessionStore;
  private broadcaster: ConsumerBroadcaster;
  private gatekeeper: ConsumerGatekeeper;
  private gitResolver: GitInfoResolver | null;
  private gitTracker: GitInfoTracker;
  private logger: Logger;
  private config: ResolvedConfig;
  private metrics: MetricsCollector | null;
  private localHandler: LocalHandler;
  private commandChain: SlashCommandChain;
  private queueHandler: MessageQueueHandler;
  private capabilitiesProtocol: CapabilitiesProtocol;
  private backendLifecycle: BackendLifecycleManager;
  private messageRouter: UnifiedMessageRouter;
  private consumerTransport: ConsumerTransportCoordinator;
  private tracer: MessageTracer;

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
    this.store = new SessionStore(options?.storage ?? null, {
      createCorrelationBuffer: () => new TeamToolCorrelationBuffer(),
      createRegistry: () => new SlashCommandRegistry(),
    });
    this.logger = options?.logger ?? noopLogger;
    this.config = resolveConfig(options?.config ?? { port: 3456 });
    this.tracer = options?.tracer ?? noopTracer;
    this.broadcaster = new ConsumerBroadcaster(
      this.logger,
      (sessionId, msg) => this.emit("message:outbound", { sessionId, message: msg }),
      this.tracer,
    );
    this.gatekeeper = new ConsumerGatekeeper(
      options?.authenticator ?? null,
      this.config,
      options?.rateLimiterFactory,
    );
    this.gitResolver = options?.gitResolver ?? null;
    this.gitTracker = new GitInfoTracker(this.gitResolver);
    this.metrics = options?.metrics ?? null;
    const emitEvent = this.forwardEvent.bind(this);
    this.capabilitiesProtocol = new CapabilitiesProtocol(
      this.config,
      this.logger,
      this.broadcaster,
      emitEvent,
      (session) => this.persistSession(session),
    );
    this.queueHandler = new MessageQueueHandler(this.broadcaster, (sessionId, content, opts) =>
      this.sendUserMessage(sessionId, content, opts),
    );
    const executor = new SlashCommandExecutor();
    this.localHandler = new LocalHandler({ executor, broadcaster: this.broadcaster, emitEvent });
    this.commandChain = new SlashCommandChain([
      this.localHandler,
      new AdapterNativeHandler({ broadcaster: this.broadcaster, emitEvent }),
      new PassthroughHandler({
        broadcaster: this.broadcaster,
        emitEvent,
        sendUserMessage: (sessionId, content) => this.sendUserMessage(sessionId, content),
      }),
      new UnsupportedHandler({ broadcaster: this.broadcaster, emitEvent }),
    ]);
    this.messageRouter = new UnifiedMessageRouter({
      broadcaster: this.broadcaster,
      capabilitiesProtocol: this.capabilitiesProtocol,
      queueHandler: this.queueHandler,
      gitTracker: this.gitTracker,
      gitResolver: this.gitResolver,
      emitEvent,
      persistSession: (session) => this.persistSession(session),
      maxMessageHistoryLength: this.config.maxMessageHistoryLength,
      tracer: this.tracer,
    });
    this.backendLifecycle = new BackendLifecycleManager({
      adapter: options?.adapter ?? null,
      adapterResolver: options?.adapterResolver ?? null,
      logger: this.logger,
      metrics: this.metrics,
      broadcaster: this.broadcaster,
      routeUnifiedMessage: (session, msg) => this.messageRouter.route(session, msg),
      emitEvent,
      tracer: this.tracer,
    });
    this.consumerTransport = new ConsumerTransportCoordinator({
      sessions: {
        get: (sessionId) => this.store.get(sessionId),
      },
      gatekeeper: this.gatekeeper,
      broadcaster: this.broadcaster,
      gitTracker: this.gitTracker,
      logger: this.logger,
      metrics: this.metrics,
      emit: this.forwardBridgeEvent.bind(this),
      routeConsumerMessage: (session, msg, ws) => this.routeConsumerMessage(session, msg, ws),
      maxConsumerMessageSize: MAX_CONSUMER_MESSAGE_SIZE,
      tracer: this.tracer,
    });
  }

  // ── Event forwarding ─────────────────────────────────────────────────────

  /** Forward a typed event from a delegate to the bridge's event emitter. */
  private forwardEvent(type: string, payload: unknown): void {
    this.emit(type as keyof BridgeEventMap, payload as BridgeEventMap[keyof BridgeEventMap]);
  }

  private forwardBridgeEvent<K extends keyof BridgeEventMap>(
    type: K,
    payload: BridgeEventMap[K],
  ): void {
    this.emit(type, payload);
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
    session.adapterName = name;
    session.state.adapterName = name;
    this.persistSession(session);
  }

  /**
   * Seed a session's state with known launch parameters (cwd, model, etc.)
   * and eagerly resolve git info. Call this right after launcher.launch()
   * so consumers connecting before the CLI's system.init see useful state.
   */
  seedSessionState(sessionId: string, params: { cwd?: string; model?: string }): void {
    const session = this.getOrCreateSession(sessionId);
    if (params.cwd) session.state.cwd = params.cwd;
    if (params.model) session.state.model = params.model;
    this.gitTracker.resolveGitInfo(session);
  }

  /** Get a read-only snapshot of a session's state. */
  getSession(sessionId: string): SessionSnapshot | undefined {
    return this.store.getSnapshot(sessionId);
  }

  getAllSessions(): SessionState[] {
    return this.store.getAllStates();
  }

  isCliConnected(sessionId: string): boolean {
    return this.store.isCliConnected(sessionId);
  }

  /** Expose storage for archival operations (BridgeOperations interface). */
  get storage(): SessionStorage | null {
    return this.store.getStorage();
  }

  removeSession(sessionId: string): void {
    const session = this.store.get(sessionId);
    if (session) {
      this.capabilitiesProtocol.cancelPendingInitialize(session);
    }
    this.store.remove(sessionId);
  }

  /** Close all sockets (CLI + consumers) and backend sessions, then remove. */
  async closeSession(sessionId: string): Promise<void> {
    const session = this.store.get(sessionId);
    if (!session) return;

    this.capabilitiesProtocol.cancelPendingInitialize(session);

    // Close backend session and await it so the subprocess is fully terminated
    // before the caller proceeds (prevents port-reuse races in sequential tests).
    if (session.backendSession) {
      session.backendAbort?.abort();
      await session.backendSession.close().catch((err) => {
        this.logger.warn("Failed to close backend session", { sessionId: session.id, error: err });
      });
      session.backendSession = null;
      session.backendAbort = null;
    }

    // Close all consumer sockets
    for (const ws of session.consumerSockets.keys()) {
      try {
        ws.close();
      } catch {
        // ignore close errors
      }
    }
    session.consumerSockets.clear();

    this.store.remove(sessionId);
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
    this.tracer.destroy();
    this.removeAllListeners();
  }

  // ── Consumer WebSocket handlers ──────────────────────────────────────────

  handleConsumerOpen(ws: WebSocketLike, context: AuthContext): void {
    this.consumerTransport.handleConsumerOpen(ws, context);
  }

  handleConsumerMessage(ws: WebSocketLike, sessionId: string, data: string | Buffer): void {
    this.consumerTransport.handleConsumerMessage(ws, sessionId, data);
  }

  handleConsumerClose(ws: WebSocketLike, sessionId: string): void {
    this.consumerTransport.handleConsumerClose(ws, sessionId);
  }

  // ── Programmatic API ─────────────────────────────────────────────────────

  /** Send a user message to the CLI for a session (no WebSocket needed). */
  sendUserMessage(
    sessionId: string,
    content: string,
    options?: {
      sessionIdOverride?: string;
      images?: { media_type: string; data: string }[];
    },
  ): void {
    const session = this.store.get(sessionId);
    if (!session) return;

    // Store user message in history for replay and broadcast to all consumers
    const userMsg: ConsumerMessage = {
      type: "user_message",
      content,
      timestamp: Date.now(),
    };
    session.messageHistory.push(userMsg);
    this.trimMessageHistory(session);
    this.broadcaster.broadcast(session, userMsg);

    // Normalize consumer input into a UnifiedMessage (T1 boundary)
    const unified = this.tracedNormalizeInbound(
      {
        type: "user_message",
        content,
        session_id: options?.sessionIdOverride || session.backendSessionId || "",
        images: options?.images,
      },
      sessionId,
    );
    if (!unified) return;

    // Route through BackendSession or queue for later
    if (session.backendSession) {
      session.backendSession.send(unified);
    } else {
      session.pendingMessages.push(unified);
    }
    this.persistSession(session);
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
    const session = this.store.get(sessionId);
    if (!session) return;

    // Early return for unknown permission request_ids (S4)
    const pending = session.pendingPermissions.get(requestId);
    if (!pending) {
      this.logger.warn(
        `Permission response for unknown request_id ${requestId} in session ${sessionId}`,
      );
      return;
    }
    session.pendingPermissions.delete(requestId);

    this.emit("permission:resolved", { sessionId, requestId, behavior });

    // Route through BackendSession (T1 boundary)
    if (session.backendSession) {
      const unified = this.tracedNormalizeInbound(
        {
          type: "permission_response",
          request_id: requestId,
          behavior,
          updated_input: options?.updatedInput,
          updated_permissions: options?.updatedPermissions as
            | import("../types/cli-messages.js").PermissionUpdate[]
            | undefined,
          message: options?.message,
        },
        sessionId,
      );
      if (unified) {
        session.backendSession.send(unified);
      }
    }
  }

  /** Send an interrupt to the CLI for a session. */
  sendInterrupt(sessionId: string): void {
    this.sendControlRequest(sessionId, { subtype: "interrupt" });
  }

  /** Send a set_model control request to the CLI. */
  sendSetModel(sessionId: string, model: string): void {
    this.sendControlRequest(sessionId, { subtype: "set_model", model });
  }

  /** Send a set_permission_mode control request to the CLI. */
  sendSetPermissionMode(sessionId: string, mode: string): void {
    this.sendControlRequest(sessionId, { subtype: "set_permission_mode", mode });
  }

  private sendControlRequest(sessionId: string, request: Record<string, unknown>): void {
    const session = this.store.get(sessionId);
    if (!session?.backendSession) return;

    let unified: UnifiedMessage | null = null;
    if (request.subtype === "interrupt") {
      unified = this.tracedNormalizeInbound({ type: "interrupt" }, sessionId);
    } else if (request.subtype === "set_model") {
      unified = this.tracedNormalizeInbound(
        { type: "set_model", model: request.model as string },
        sessionId,
      );
    } else if (request.subtype === "set_permission_mode") {
      unified = this.tracedNormalizeInbound(
        { type: "set_permission_mode", mode: request.mode as string },
        sessionId,
      );
    }

    if (unified) {
      session.backendSession.send(unified);
    }
  }

  // ── Structured data APIs ───────────────────────────────────────────────

  getSupportedModels(sessionId: string): InitializeModel[] {
    return this.store.get(sessionId)?.state.capabilities?.models ?? [];
  }

  getSupportedCommands(sessionId: string): InitializeCommand[] {
    return this.store.get(sessionId)?.state.capabilities?.commands ?? [];
  }

  getAccountInfo(sessionId: string): InitializeAccount | null {
    return this.store.get(sessionId)?.state.capabilities?.account ?? null;
  }

  // ── Consumer message routing ─────────────────────────────────────────────

  private routeConsumerMessage(session: Session, msg: InboundMessage, ws: WebSocketLike): void {
    switch (msg.type) {
      case "user_message":
        this.handleUserMessage(session, msg);
        break;
      case "permission_response":
        this.handlePermissionResponse(session, msg);
        break;
      case "interrupt":
        this.sendInterrupt(session.id);
        break;
      case "set_model":
        this.sendSetModel(session.id, msg.model);
        break;
      case "set_permission_mode":
        this.sendSetPermissionMode(session.id, msg.mode);
        break;
      case "presence_query":
        this.broadcaster.broadcastPresence(session);
        break;
      case "slash_command":
        this.commandChain.dispatch({
          command: msg.command,
          requestId: msg.request_id,
          session,
        });
        break;
      case "queue_message":
        this.queueHandler.handleQueueMessage(session, msg, ws);
        break;
      case "update_queued_message":
        this.queueHandler.handleUpdateQueuedMessage(session, msg, ws);
        break;
      case "cancel_queued_message":
        this.queueHandler.handleCancelQueuedMessage(session, ws);
        break;
      case "set_adapter":
        this.broadcaster.sendTo(ws, {
          type: "error",
          message:
            "Adapter cannot be changed on an active session. Create a new session with the desired adapter.",
        });
        break;
    }
  }

  private handleUserMessage(
    session: Session,
    msg: {
      type: "user_message";
      content: string;
      session_id?: string;
      images?: { media_type: string; data: string }[];
    },
  ): void {
    // Optimistically mark running — the CLI will process this message, but
    // message_start won't arrive until the API starts streaming (1-5s gap).
    // Without this, queue_message arriving in that gap sees lastStatus as
    // null/idle and bypasses the queue.
    session.lastStatus = "running";
    this.sendUserMessage(session.id, msg.content, {
      sessionIdOverride: msg.session_id,
      images: msg.images,
    });
  }

  private handlePermissionResponse(
    session: Session,
    msg: {
      type: "permission_response";
      request_id: string;
      behavior: "allow" | "deny";
      updated_input?: Record<string, unknown>;
      updated_permissions?: unknown[];
      message?: string;
    },
  ): void {
    this.sendPermissionResponse(session.id, msg.request_id, msg.behavior, {
      updatedInput: msg.updated_input,
      updatedPermissions: msg.updated_permissions,
      message: msg.message,
    });
  }

  // ── Slash command handling (delegated to SlashCommandChain) ─────────────────

  /** Execute a slash command programmatically (no WebSocket needed). */
  async executeSlashCommand(
    sessionId: string,
    command: string,
  ): Promise<{ content: string; source: "emulated" } | null> {
    const session = this.store.get(sessionId);
    if (!session) return null;
    const ctx = { command, requestId: undefined, session };
    if (this.localHandler.handles(ctx)) {
      return this.localHandler.executeLocal(ctx);
    }
    // For non-local commands: dispatch via chain (side-effectful; result comes via broadcast)
    this.commandChain.dispatch(ctx);
    return null;
  }

  /** Push a session name update to all connected consumers for a session. */
  broadcastNameUpdate(sessionId: string, name: string): void {
    const session = this.store.get(sessionId);
    if (!session) return;
    this.broadcaster.broadcastNameUpdate(session, name);
  }

  /** Broadcast resume_failed to all consumers for a session. */
  broadcastResumeFailedToConsumers(sessionId: string): void {
    const session = this.store.get(sessionId);
    if (!session) return;
    this.broadcaster.broadcastResumeFailed(session, sessionId);
  }

  /** Broadcast process output to participants only (observers must not see process logs). */
  broadcastProcessOutput(sessionId: string, stream: "stdout" | "stderr", data: string): void {
    const session = this.store.get(sessionId);
    if (!session) return;
    this.broadcaster.broadcastProcessOutput(session, stream, data);
  }

  /** Broadcast watchdog state update via session_update. */
  broadcastWatchdogState(
    sessionId: string,
    watchdog: { gracePeriodMs: number; startedAt: number } | null,
  ): void {
    const session = this.store.get(sessionId);
    if (!session) return;
    this.broadcaster.broadcastWatchdogState(session, watchdog);
  }

  /** Broadcast circuit breaker state update via session_update. */
  broadcastCircuitBreakerState(
    sessionId: string,
    circuitBreaker: { state: string; failureCount: number; recoveryTimeRemainingMs: number },
  ): void {
    const session = this.store.get(sessionId);
    if (!session) return;
    this.broadcaster.broadcastCircuitBreakerState(session, circuitBreaker);
  }

  // ── Traced normalizeInbound (T1 boundary) ────────────────────────────────

  private tracedNormalizeInbound(
    msg: InboundMessage,
    sessionId: string,
    traceId?: string,
  ): UnifiedMessage | null {
    const unified = normalizeInbound(msg);
    this.tracer.translate(
      "normalizeInbound",
      "T1",
      { format: "InboundMessage", body: msg },
      { format: "UnifiedMessage", body: unified },
      { sessionId, traceId },
    );
    if (!unified) {
      this.tracer.error("bridge", msg.type, "normalizeInbound returned null", {
        sessionId,
        traceId,
        action: "dropped",
      });
    }
    return unified;
  }

  // ── Message history management ───────────────────────────────────────────

  /** Trim message history to the configured max length (P1). */
  private trimMessageHistory(session: Session): void {
    const maxLength = this.config.maxMessageHistoryLength;
    if (session.messageHistory.length > maxLength) {
      session.messageHistory = session.messageHistory.slice(-maxLength);
    }
  }

  // ── BackendAdapter path (delegated to BackendLifecycleManager) ──────────

  /** Whether a BackendAdapter is configured. */
  get hasAdapter(): boolean {
    return this.backendLifecycle.hasAdapter;
  }

  /** Connect a session via BackendAdapter and start consuming messages. */
  async connectBackend(
    sessionId: string,
    options?: { resume?: boolean; adapterOptions?: Record<string, unknown> },
  ): Promise<void> {
    const session = this.getOrCreateSession(sessionId);
    return this.backendLifecycle.connectBackend(session, options);
  }

  /** Disconnect the backend session. */
  async disconnectBackend(sessionId: string): Promise<void> {
    const session = this.store.get(sessionId);
    if (!session) return;
    this.capabilitiesProtocol.cancelPendingInitialize(session);
    return this.backendLifecycle.disconnectBackend(session);
  }

  /** Whether a backend session is connected for a given session ID. */
  isBackendConnected(sessionId: string): boolean {
    const session = this.store.get(sessionId);
    if (!session) return false;
    return this.backendLifecycle.isBackendConnected(session);
  }

  /** Send a UnifiedMessage to the backend session. */
  sendToBackend(sessionId: string, message: UnifiedMessage): void {
    const session = this.store.get(sessionId);
    if (!session) {
      this.logger.warn(`No backend session for ${sessionId}, cannot send message`);
      return;
    }
    this.backendLifecycle.sendToBackend(session, message);
  }
}
