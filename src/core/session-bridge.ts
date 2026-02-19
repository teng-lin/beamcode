import type { AdapterResolver } from "../adapters/adapter-resolver.js";
import { noopLogger } from "../adapters/noop-logger.js";
import type { AuthContext, Authenticator, ConsumerIdentity } from "../interfaces/auth.js";
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
import { inboundMessageSchema } from "../types/inbound-message-schema.js";
import type { InboundMessage } from "../types/inbound-messages.js";
import type { SessionSnapshot, SessionState } from "../types/session-state.js";
import { BackendLifecycleManager } from "./backend-lifecycle-manager.js";
import { CapabilitiesProtocol } from "./capabilities-protocol.js";
import { ConsumerBroadcaster, MAX_CONSUMER_MESSAGE_SIZE } from "./consumer-broadcaster.js";
import { ConsumerGatekeeper, type RateLimiterFactory } from "./consumer-gatekeeper.js";
import { GitInfoTracker } from "./git-info-tracker.js";
import { normalizeInbound } from "./inbound-normalizer.js";
import type { BackendAdapter } from "./interfaces/backend-adapter.js";
import { MessageQueueHandler } from "./message-queue-handler.js";
import type { Session } from "./session-store.js";
import { SessionStore } from "./session-store.js";
import { SlashCommandExecutor } from "./slash-command-executor.js";
import { SlashCommandHandler } from "./slash-command-handler.js";
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
  private slashCommandExecutor: SlashCommandExecutor;
  private queueHandler: MessageQueueHandler;
  private capabilitiesProtocol: CapabilitiesProtocol;
  private backendLifecycle: BackendLifecycleManager;
  private slashCommandHandler: SlashCommandHandler;
  private messageRouter: UnifiedMessageRouter;

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
  }) {
    super();
    this.store = new SessionStore(options?.storage ?? null, {
      createCorrelationBuffer: () => new TeamToolCorrelationBuffer(),
      createRegistry: () => new SlashCommandRegistry(),
    });
    this.logger = options?.logger ?? noopLogger;
    this.config = resolveConfig(options?.config ?? { port: 3456 });
    this.broadcaster = new ConsumerBroadcaster(this.logger, (sessionId, msg) =>
      this.emit("message:outbound", { sessionId, message: msg }),
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
    this.slashCommandExecutor = new SlashCommandExecutor();
    this.messageRouter = new UnifiedMessageRouter({
      broadcaster: this.broadcaster,
      capabilitiesProtocol: this.capabilitiesProtocol,
      queueHandler: this.queueHandler,
      gitTracker: this.gitTracker,
      gitResolver: this.gitResolver,
      emitEvent,
      persistSession: (session) => this.persistSession(session),
      maxMessageHistoryLength: this.config.maxMessageHistoryLength,
    });
    this.backendLifecycle = new BackendLifecycleManager({
      adapter: options?.adapter ?? null,
      adapterResolver: options?.adapterResolver ?? null,
      logger: this.logger,
      metrics: this.metrics,
      broadcaster: this.broadcaster,
      routeUnifiedMessage: (session, msg) => this.messageRouter.route(session, msg),
      emitEvent,
    });
    this.slashCommandHandler = new SlashCommandHandler({
      executor: this.slashCommandExecutor,
      broadcaster: this.broadcaster,
      sendUserMessage: (sessionId, content, opts) => this.sendUserMessage(sessionId, content, opts),
      emitEvent,
    });
  }

  // ── Event forwarding ─────────────────────────────────────────────────────

  /** Forward a typed event from a delegate to the bridge's event emitter. */
  private forwardEvent(type: string, payload: unknown): void {
    this.emit(type as keyof BridgeEventMap, payload as BridgeEventMap[keyof BridgeEventMap]);
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
  closeSession(sessionId: string): void {
    const session = this.store.get(sessionId);
    if (!session) return;

    this.capabilitiesProtocol.cancelPendingInitialize(session);

    // Close backend session
    if (session.backendSession) {
      session.backendAbort?.abort();
      session.backendSession.close().catch((err) => {
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
  close(): void {
    for (const sessionId of Array.from(this.store.keys())) {
      this.closeSession(sessionId);
    }
    this.slashCommandExecutor.dispose();
    this.removeAllListeners();
  }

  // ── Consumer WebSocket handlers ──────────────────────────────────────────

  handleConsumerOpen(ws: WebSocketLike, context: AuthContext): void {
    const session = this.getOrCreateSession(context.sessionId);

    if (this.gatekeeper.hasAuthenticator()) {
      // Async auth path — authenticateAsync may throw synchronously or reject
      let authResult: Promise<ConsumerIdentity | null>;
      try {
        authResult = this.gatekeeper.authenticateAsync(ws, context);
      } catch (err) {
        this.rejectConsumer(ws, context.sessionId, err);
        return;
      }
      authResult
        .then((identity) => {
          if (!identity) return; // socket closed during auth
          this.acceptConsumer(ws, context.sessionId, identity);
        })
        .catch((err) => {
          this.rejectConsumer(ws, context.sessionId, err);
        });
    } else {
      // Sync anonymous auth path (preserves original synchronous behavior)
      session.anonymousCounter++;
      const identity = this.gatekeeper.createAnonymousIdentity(session.anonymousCounter);
      this.acceptConsumer(ws, context.sessionId, identity);
    }
  }

  private rejectConsumer(ws: WebSocketLike, sessionId: string, err: unknown): void {
    const reason = err instanceof Error ? err.message : String(err);
    this.emit("consumer:auth_failed", { sessionId, reason });
    this.metrics?.recordEvent({
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

  private acceptConsumer(ws: WebSocketLike, sessionId: string, identity: ConsumerIdentity): void {
    const session = this.store.get(sessionId);
    if (!session) {
      // Session was removed during async authentication
      this.rejectConsumer(ws, sessionId, new Error("Session closed during authentication"));
      return;
    }
    session.consumerSockets.set(ws, identity);
    this.logger.info(
      `Consumer connected for session ${sessionId} (${session.consumerSockets.size} consumers)`,
    );
    this.metrics?.recordEvent({
      timestamp: Date.now(),
      type: "consumer:connected",
      sessionId,
      userId: identity.userId,
    });

    // Send identity to the new consumer
    this.broadcaster.sendTo(ws, {
      type: "identity",
      userId: identity.userId,
      displayName: identity.displayName,
      role: identity.role,
    });

    // Eagerly resolve git info if cwd is known but git info is missing
    // (e.g. resumed session where CLI hasn't reconnected yet)
    this.gitTracker.resolveGitInfo(session);

    // Send current session state as snapshot
    this.broadcaster.sendTo(ws, {
      type: "session_init",
      session: session.state,
    });

    // Replay message history so the consumer can reconstruct the conversation
    if (session.messageHistory.length > 0) {
      this.broadcaster.sendTo(ws, {
        type: "message_history",
        messages: session.messageHistory,
      });
    }

    // Send capabilities if already available
    if (session.state.capabilities) {
      this.broadcaster.sendTo(ws, {
        type: "capabilities_ready",
        commands: session.state.capabilities.commands,
        models: session.state.capabilities.models,
        account: session.state.capabilities.account,
        skills: session.state.skills,
      });
    }

    // Send pending permission requests only to participants
    if (identity.role === "participant") {
      for (const perm of session.pendingPermissions.values()) {
        this.broadcaster.sendTo(ws, { type: "permission_request", request: perm });
      }
    }

    // Send current queued message state (if any)
    if (session.queuedMessage) {
      this.broadcaster.sendTo(ws, {
        type: "message_queued",
        consumer_id: session.queuedMessage.consumerId,
        display_name: session.queuedMessage.displayName,
        content: session.queuedMessage.content,
        images: session.queuedMessage.images,
        queued_at: session.queuedMessage.queuedAt,
      });
    }

    // Broadcast presence update to all consumers
    this.broadcaster.broadcastPresence(session);

    this.emit("consumer:authenticated", {
      sessionId,
      userId: identity.userId,
      displayName: identity.displayName,
      role: identity.role,
    });
    this.emit("consumer:connected", {
      sessionId,
      consumerCount: session.consumerSockets.size,
      identity,
    });

    // Notify consumer of current backend connection state
    if (session.backendSession) {
      this.broadcaster.sendTo(ws, { type: "cli_connected" });
    } else {
      this.broadcaster.sendTo(ws, { type: "cli_disconnected" });
      this.logger.info(
        `Consumer connected but CLI is dead for session ${sessionId}, requesting relaunch`,
      );
      this.emit("backend:relaunch_needed", { sessionId });
    }
  }

  handleConsumerMessage(ws: WebSocketLike, sessionId: string, data: string | Buffer): void {
    const raw = typeof data === "string" ? data : data.toString("utf-8");
    const session = this.store.get(sessionId);
    if (!session) return;

    session.lastActivity = Date.now();

    // Reject oversized messages before parsing
    if (raw.length > MAX_CONSUMER_MESSAGE_SIZE) {
      this.logger.warn(
        `Oversized consumer message rejected for session ${sessionId}: ${raw.length} bytes (max ${MAX_CONSUMER_MESSAGE_SIZE})`,
      );
      ws.close(1009, "Message Too Big");
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.logger.warn(`Failed to parse consumer message: ${raw.substring(0, 200)}`);
      return;
    }

    const result = inboundMessageSchema.safeParse(parsed);
    if (!result.success) {
      this.logger.warn(`Invalid consumer message`, {
        error: result.error.issues,
        raw: raw.substring(0, 200),
      });
      return;
    }
    const msg: InboundMessage = result.data;

    // Reject messages from unregistered sockets (not yet authenticated or already removed)
    const identity = session.consumerSockets.get(ws);
    if (!identity) return;

    // Role-based access control: observers cannot send participant-only messages
    if (!this.gatekeeper.authorize(identity, msg.type)) {
      this.broadcaster.sendTo(ws, {
        type: "error",
        message: `Observers cannot send ${msg.type} messages`,
      });
      return;
    }

    // Rate limiting: check if consumer has exceeded message rate limit
    if (!this.gatekeeper.checkRateLimit(ws, session)) {
      this.logger.warn(`Rate limit exceeded for consumer in session ${sessionId}`);
      this.metrics?.recordEvent({
        timestamp: Date.now(),
        type: "ratelimit:exceeded",
        sessionId,
        source: "consumer",
      });
      this.broadcaster.sendTo(ws, {
        type: "error",
        message: "Rate limit exceeded. Please slow down your message rate.",
      });
      return;
    }

    this.emit("message:inbound", { sessionId, message: msg });
    this.routeConsumerMessage(session, msg, ws);
  }

  handleConsumerClose(ws: WebSocketLike, sessionId: string): void {
    this.gatekeeper.cancelPendingAuth(ws); // cancel auth in progress
    const session = this.store.get(sessionId);
    if (!session) return;

    const identity = session.consumerSockets.get(ws);
    session.consumerSockets.delete(ws);
    session.consumerRateLimiters.delete(ws); // Clean up rate limiter
    this.logger.info(
      `Consumer disconnected for session ${sessionId} (${session.consumerSockets.size} consumers)`,
    );
    if (identity) {
      this.metrics?.recordEvent({
        timestamp: Date.now(),
        type: "consumer:disconnected",
        sessionId,
        userId: identity.userId,
      });
    }
    this.emit("consumer:disconnected", {
      sessionId,
      consumerCount: session.consumerSockets.size,
      identity,
    });
    this.broadcaster.broadcastPresence(session);
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

    // Normalize consumer input into a UnifiedMessage
    const unified = normalizeInbound({
      type: "user_message",
      content,
      session_id: options?.sessionIdOverride || session.backendSessionId || "",
      images: options?.images,
    });
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

    // Route through BackendSession
    if (session.backendSession) {
      const unified = normalizeInbound({
        type: "permission_response",
        request_id: requestId,
        behavior,
        updated_input: options?.updatedInput,
        updated_permissions: options?.updatedPermissions as
          | import("../types/cli-messages.js").PermissionUpdate[]
          | undefined,
        message: options?.message,
      });
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
      unified = normalizeInbound({ type: "interrupt" });
    } else if (request.subtype === "set_model") {
      unified = normalizeInbound({ type: "set_model", model: request.model as string });
    } else if (request.subtype === "set_permission_mode") {
      unified = normalizeInbound({ type: "set_permission_mode", mode: request.mode as string });
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
        this.handleSlashCommandWithAdapter(session, msg);
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

  private handleSlashCommandWithAdapter(
    session: Session,
    msg: { type: "slash_command"; command: string; request_id?: string },
  ): void {
    const { command, request_id } = msg;
    const executor = session.adapterSlashExecutor;

    // Try adapter-specific executor first (e.g. Codex → JSON-RPC)
    if (executor?.handles(command)) {
      executor
        .execute(command)
        .then((result) => {
          if (!result) {
            this.slashCommandHandler.handleSlashCommand(session, msg);
            return;
          }
          this.broadcaster.broadcast(session, {
            type: "slash_command_result",
            command,
            request_id,
            content: result.content,
            source: result.source,
          });
          this.emit("slash_command:executed", {
            sessionId: session.id,
            command,
            source: result.source,
            durationMs: result.durationMs,
          });
        })
        .catch((err) => {
          const error = err instanceof Error ? err.message : String(err);
          this.broadcaster.broadcast(session, {
            type: "slash_command_error",
            command,
            request_id,
            error,
          });
          this.emit("slash_command:failed", {
            sessionId: session.id,
            command,
            error,
          });
        });
      return;
    }

    // Fallback: existing handler (local /help or forward to CLI)
    this.slashCommandHandler.handleSlashCommand(session, msg);
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

  // ── Slash command handling (delegated to SlashCommandHandler) ────────────

  /** Execute a slash command programmatically (no WebSocket needed). */
  async executeSlashCommand(
    sessionId: string,
    command: string,
  ): Promise<{ content: string; source: "emulated" } | null> {
    const session = this.store.get(sessionId);
    if (!session) return null;
    return this.slashCommandHandler.executeSlashCommand(session, command);
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
