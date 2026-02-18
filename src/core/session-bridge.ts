import { randomUUID } from "node:crypto";
import { ConsoleLogger } from "../adapters/console-logger.js";
import { translate as translateCLI } from "../adapters/sdk-url/message-translator.js";
import { reduce as reduceState } from "../adapters/sdk-url/state-reducer.js";
import type { AuthContext, Authenticator, ConsumerIdentity } from "../interfaces/auth.js";
import type { CommandRunner } from "../interfaces/command-runner.js";
import type { GitInfoResolver } from "../interfaces/git-resolver.js";
import type { Logger } from "../interfaces/logger.js";
import type { MetricsCollector } from "../interfaces/metrics.js";
import type { SessionStorage } from "../interfaces/storage.js";
import type { WebSocketLike } from "../interfaces/transport.js";
import type {
  CLIMessage,
  InitializeAccount,
  InitializeCommand,
  InitializeModel,
  PermissionRequest,
} from "../types/cli-messages.js";
import type { ProviderConfig, ResolvedConfig } from "../types/config.js";
import { resolveConfig } from "../types/config.js";
import type { ConsumerMessage, ConsumerPermissionRequest } from "../types/consumer-messages.js";
import type { BridgeEventMap } from "../types/events.js";
import { inboundMessageSchema } from "../types/inbound-message-schema.js";
import type { InboundMessage } from "../types/inbound-messages.js";
import type { SessionSnapshot, SessionState } from "../types/session-state.js";
import { parseNDJSON, serializeNDJSON } from "../utils/ndjson.js";
import { ConsumerBroadcaster, MAX_CONSUMER_MESSAGE_SIZE } from "./consumer-broadcaster.js";
import { ConsumerGatekeeper } from "./consumer-gatekeeper.js";
import type { BackendAdapter } from "./interfaces/backend-adapter.js";
import type { Session } from "./session-store.js";
import { SessionStore } from "./session-store.js";
import { SlashCommandExecutor } from "./slash-command-executor.js";
import { SlashCommandRegistry } from "./slash-command-registry.js";
import { diffTeamState } from "./team-event-differ.js";
import { TeamToolCorrelationBuffer } from "./team-tool-correlation.js";
import { TypedEventEmitter } from "./typed-emitter.js";
import type { TeamState } from "./types/team-types.js";
import type { UnifiedMessage } from "./types/unified-message.js";

// ─── SessionBridge ───────────────────────────────────────────────────────────

export class SessionBridge extends TypedEventEmitter<BridgeEventMap> {
  private store: SessionStore;
  private broadcaster: ConsumerBroadcaster;
  private gatekeeper: ConsumerGatekeeper;
  private gitResolver: GitInfoResolver | null;
  private logger: Logger;
  private config: ResolvedConfig;
  private metrics: MetricsCollector | null;
  private slashCommandExecutor: SlashCommandExecutor;
  private adapter: BackendAdapter | null;

  constructor(options?: {
    storage?: SessionStorage;
    gitResolver?: GitInfoResolver;
    authenticator?: Authenticator;
    logger?: Logger;
    config?: ProviderConfig;
    metrics?: MetricsCollector;
    commandRunner?: CommandRunner;
    /** BackendAdapter for adapter-based sessions (coexistence with CLI WebSocket path). */
    adapter?: BackendAdapter;
  }) {
    super();
    this.store = new SessionStore(options?.storage ?? null, {
      createCorrelationBuffer: () => new TeamToolCorrelationBuffer(),
      createRegistry: () => new SlashCommandRegistry(),
    });
    this.logger = options?.logger ?? new ConsoleLogger("session-bridge");
    this.config = resolveConfig(options?.config ?? { port: 3456 });
    this.broadcaster = new ConsumerBroadcaster(this.logger, (sessionId, msg) =>
      this.emit("message:outbound", { sessionId, message: msg }),
    );
    this.gatekeeper = new ConsumerGatekeeper(options?.authenticator ?? null, this.config);
    this.gitResolver = options?.gitResolver ?? null;
    this.metrics = options?.metrics ?? null;
    this.adapter = options?.adapter ?? null;
    this.slashCommandExecutor = new SlashCommandExecutor({
      commandRunner: options?.commandRunner,
      config: this.config,
    });
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
      this.cancelPendingInitialize(session);
    }
    this.store.remove(sessionId);
  }

  /** Close all sockets (CLI + consumers) and backend sessions, then remove. */
  closeSession(sessionId: string): void {
    const session = this.store.get(sessionId);
    if (!session) return;

    this.cancelPendingInitialize(session);

    // Close CLI socket
    if (session.cliSocket) {
      try {
        session.cliSocket.close();
      } catch {
        // ignore close errors
      }
      session.cliSocket = null;
    }

    // Close backend session
    if (session.backendSession) {
      session.backendAbort?.abort();
      session.backendSession.close().catch(() => {});
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

  // ── CLI WebSocket handlers ───────────────────────────────────────────────

  handleCLIOpen(ws: WebSocketLike, sessionId: string): void {
    const session = this.getOrCreateSession(sessionId);
    session.cliSocket = ws;
    this.logger.info(`CLI connected for session ${sessionId}`);
    this.metrics?.recordEvent({
      timestamp: Date.now(),
      type: "cli:connected",
      sessionId,
    });
    this.broadcaster.broadcast(session, { type: "cli_connected" });
    this.emit("cli:connected", { sessionId });
    this.emit("backend:connected", { sessionId });

    // Flush any messages that were queued while waiting for CLI to connect
    if (session.pendingMessages.length > 0) {
      this.logger.info(
        `Flushing ${session.pendingMessages.length} queued message(s) for session ${sessionId}`,
      );
      for (const ndjson of session.pendingMessages) {
        this.sendToCLI(session, ndjson);
      }
      session.pendingMessages = [];
    }
  }

  handleCLIMessage(sessionId: string, data: string | Buffer): void {
    const raw = typeof data === "string" ? data : data.toString("utf-8");
    const session = this.store.get(sessionId);
    if (!session) return;

    session.lastActivity = Date.now();

    const { messages, errors } = parseNDJSON<CLIMessage>(raw);

    for (const error of errors) {
      this.logger.warn(`Failed to parse CLI message: ${error.substring(0, 200)}`);
    }

    for (const msg of messages) {
      this.routeCLIMessage(session, msg);
    }
  }

  handleCLIClose(sessionId: string): void {
    const session = this.store.get(sessionId);
    if (!session) return;

    this.cancelPendingInitialize(session);

    session.cliSocket = null;
    this.logger.info(`CLI disconnected for session ${sessionId}`);
    this.metrics?.recordEvent({
      timestamp: Date.now(),
      type: "cli:disconnected",
      sessionId,
    });
    this.broadcaster.broadcast(session, { type: "cli_disconnected" });
    this.emit("cli:disconnected", { sessionId });
    this.emit("backend:disconnected", {
      sessionId,
      code: 1000,
      reason: "CLI process disconnected",
    });

    // Cancel any pending permission requests (only participants see these)
    for (const [reqId] of session.pendingPermissions) {
      this.broadcaster.broadcastToParticipants(session, {
        type: "permission_cancelled",
        request_id: reqId,
      });
    }
    session.pendingPermissions.clear();
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

    // Notify consumer of current CLI/backend connection state
    if (session.cliSocket || session.backendSession) {
      this.broadcaster.sendTo(ws, { type: "cli_connected" });
    } else {
      this.broadcaster.sendTo(ws, { type: "cli_disconnected" });
      this.logger.info(
        `Consumer connected but CLI is dead for session ${sessionId}, requesting relaunch`,
      );
      this.emit("cli:relaunch_needed", { sessionId });
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

    // Build content: if images are present, use content block array; otherwise plain string
    const images = options?.images;
    const messageContent: string | unknown[] = images?.length
      ? [
          ...images.map((img) => ({
            type: "image",
            source: { type: "base64", media_type: img.media_type, data: img.data },
          })),
          { type: "text", text: content },
        ]
      : content;

    const ndjson = serializeNDJSON({
      type: "user",
      message: { role: "user", content: messageContent },
      parent_tool_use_id: null,
      session_id: options?.sessionIdOverride || session.state.session_id || "",
    }).trimEnd(); // serializeNDJSON adds \n, sendToCLI also adds \n
    this.sendToCLI(session, ndjson);
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

    let innerResponse: Record<string, unknown>;
    if (behavior === "allow") {
      innerResponse = {
        behavior: "allow",
        updatedInput: options?.updatedInput ?? pending.input ?? {},
      };
      if (options?.updatedPermissions?.length) {
        innerResponse.updatedPermissions = options.updatedPermissions;
      }
    } else {
      innerResponse = {
        behavior: "deny",
        message: options?.message || "Denied by user",
      };
    }

    const ndjson = JSON.stringify({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: requestId,
        response: innerResponse,
      },
    });
    this.sendToCLI(session, ndjson);
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
    if (!session) return;
    const ndjson = JSON.stringify({
      type: "control_request",
      request_id: randomUUID(),
      request,
    });
    this.sendToCLI(session, ndjson);
  }

  // ── CLI message routing ──────────────────────────────────────────────────

  private routeCLIMessage(session: Session, msg: CLIMessage): void {
    const unified = translateCLI(msg);
    if (!unified) {
      if (msg.type !== "keep_alive" && msg.type !== "user") {
        this.logger.warn(`Unrecognized CLI message type "${msg.type}" in session ${session.id}`);
      }
      return;
    }
    this.routeUnifiedMessage(session, unified);
  }

  // ── Initialize protocol ─────────────────────────────────────────────────

  private cancelPendingInitialize(session: Session): void {
    if (session.pendingInitialize) {
      clearTimeout(session.pendingInitialize.timer);
      session.pendingInitialize = null;
    }
  }

  private sendInitializeRequest(session: Session): void {
    if (session.pendingInitialize) return; // dedup
    const requestId = randomUUID();
    const timer = setTimeout(() => {
      if (session.pendingInitialize?.requestId === requestId) {
        session.pendingInitialize = null;
        this.emit("capabilities:timeout", { sessionId: session.id });
      }
    }, this.config.initializeTimeoutMs);
    session.pendingInitialize = { requestId, timer };
    this.sendToCLI(
      session,
      JSON.stringify({
        type: "control_request",
        request_id: requestId,
        request: { subtype: "initialize" },
      }),
    );
  }

  /** Apply capabilities from a control_response (used by unified handler). */
  private applyCapabilities(
    session: Session,
    commands: InitializeCommand[],
    models: InitializeModel[],
    account: InitializeAccount | null,
  ): void {
    session.state.capabilities = { commands, models, account, receivedAt: Date.now() };
    this.logger.info(
      `Capabilities received for session ${session.id}: ${commands.length} commands, ${models.length} models`,
    );

    if (commands.length > 0) {
      session.registry.registerFromCLI(commands);
    }

    this.broadcaster.broadcast(session, {
      type: "capabilities_ready",
      commands,
      models,
      account,
      skills: session.state.skills,
    });
    this.emit("capabilities:ready", { sessionId: session.id, commands, models, account });
    this.persistSession(session);
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
        this.handleSlashCommand(session, msg);
        break;
      case "queue_message":
        this.handleQueueMessage(session, msg, ws);
        break;
      case "update_queued_message":
        this.handleUpdateQueuedMessage(session, msg, ws);
        break;
      case "cancel_queued_message":
        this.handleCancelQueuedMessage(session, ws);
        break;
      case "set_adapter":
        this.logger.info(
          `[set_adapter] session=${session.id} adapter=${msg.adapter} (no-op: adapter switching not yet supported)`,
        );
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

  // ── Queue message handling ──────────────────────────────────────────────

  private handleQueueMessage(
    session: Session,
    msg: {
      type: "queue_message";
      content: string;
      images?: { media_type: string; data: string }[];
    },
    ws: WebSocketLike,
  ): void {
    // If session is idle or its status is unknown, send immediately as user_message.
    // Otherwise (e.g. "running", "compacting"), proceed to queue it.
    const status = session.lastStatus;
    if (!status || status === "idle") {
      this.handleUserMessage(session, {
        type: "user_message",
        content: msg.content,
        images: msg.images,
      });
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

  private handleUpdateQueuedMessage(
    session: Session,
    msg: {
      type: "update_queued_message";
      content: string;
      images?: { media_type: string; data: string }[];
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

  private handleCancelQueuedMessage(session: Session, ws: WebSocketLike): void {
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

  // ── Slash command handling ───────────────────────────────────────────────

  /** Returns true if the command should be forwarded to the CLI as a user message (native or skill). */
  private shouldForwardToCLI(command: string, session: Session): boolean {
    return (
      this.slashCommandExecutor.isNativeCommand(command, session.state) ||
      this.slashCommandExecutor.isSkillCommand(command, session.registry)
    );
  }

  private handleSlashCommand(
    session: Session,
    msg: { type: "slash_command"; command: string; request_id?: string },
  ): void {
    const { command, request_id } = msg;

    if (this.shouldForwardToCLI(command, session)) {
      this.sendUserMessage(session.id, command);
      return;
    }

    if (!this.slashCommandExecutor.canHandle(command, session.state)) {
      const errorMsg = `Unknown slash command: ${command.split(/\s+/)[0]}`;
      this.broadcaster.broadcast(session, {
        type: "slash_command_error",
        command,
        request_id,
        error: errorMsg,
      });
      this.emit("slash_command:failed", {
        sessionId: session.id,
        command,
        error: errorMsg,
      });
      return;
    }

    this.slashCommandExecutor
      .execute(session.state, command, session.cliSessionId ?? session.id, session.registry)
      .then((result) => {
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
  }

  /** Execute a slash command programmatically (no WebSocket needed). */
  async executeSlashCommand(
    sessionId: string,
    command: string,
  ): Promise<{ content: string; source: "emulated" | "pty" } | null> {
    const session = this.store.get(sessionId);
    if (!session) return null;

    if (this.shouldForwardToCLI(command, session)) {
      this.sendUserMessage(sessionId, command);
      return null; // result comes back via normal CLI message flow
    }

    if (!this.slashCommandExecutor.canHandle(command, session.state)) {
      return null;
    }

    const result = await this.slashCommandExecutor.execute(
      session.state,
      command,
      session.cliSessionId ?? session.id,
      session.registry,
    );
    return { content: result.content, source: result.source };
  }

  // ── Transport helpers ────────────────────────────────────────────────────

  private sendToCLI(session: Session, ndjson: string): void {
    if (!session.cliSocket) {
      // Queue the message — CLI might still be starting up
      this.logger.info(`CLI not yet connected for session ${session.id}, queuing message`);
      // Cap pending messages to prevent unbounded memory growth
      if (session.pendingMessages.length >= this.config.pendingMessageQueueMaxSize) {
        this.logger.warn(
          `Pending message queue full for session ${session.id}, dropping oldest message`,
        );
        session.pendingMessages.shift();
      }
      session.pendingMessages.push(ndjson);
      return;
    }
    try {
      // NDJSON requires a newline delimiter
      session.cliSocket.send(`${ndjson}\n`);
    } catch (err) {
      this.logger.error(`Failed to send to CLI for session ${session.id}`, {
        error: err,
      });
      this.emit("error", {
        source: "sendToCLI",
        error: err instanceof Error ? err : new Error(String(err)),
        sessionId: session.id,
      });
    }
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

  // ── BackendAdapter path (coexistence with CLI WebSocket path) ───────────

  /** Whether a BackendAdapter is configured. */
  get hasAdapter(): boolean {
    return this.adapter !== null;
  }

  /** Connect a session via BackendAdapter and start consuming messages. */
  async connectBackend(
    sessionId: string,
    options?: { resume?: boolean; adapterOptions?: Record<string, unknown> },
  ): Promise<void> {
    if (!this.adapter) {
      throw new Error("No BackendAdapter configured");
    }
    const session = this.getOrCreateSession(sessionId);

    // Close any existing backend session
    if (session.backendSession) {
      session.backendAbort?.abort();
      await session.backendSession.close().catch(() => {});
    }

    const backendSession = await this.adapter.connect({
      sessionId,
      resume: options?.resume,
      adapterOptions: options?.adapterOptions,
    });

    session.backendSession = backendSession;
    const abort = new AbortController();
    session.backendAbort = abort;

    this.logger.info(`Backend connected for session ${sessionId} via ${this.adapter.name}`);
    this.metrics?.recordEvent({
      timestamp: Date.now(),
      type: "cli:connected",
      sessionId,
    });
    this.broadcaster.broadcast(session, { type: "cli_connected" });
    this.emit("backend:connected", { sessionId });
    this.emit("cli:connected", { sessionId });

    // Flush any pending messages
    if (session.pendingMessages.length > 0) {
      this.logger.info(
        `Flushing ${session.pendingMessages.length} queued message(s) for session ${sessionId}`,
      );
      for (const ndjson of session.pendingMessages) {
        this.sendToCLI(session, ndjson);
      }
      session.pendingMessages = [];
    }

    // Start consuming backend messages in the background
    this.startBackendConsumption(session, abort.signal);
  }

  /** Disconnect the backend session. */
  async disconnectBackend(sessionId: string): Promise<void> {
    const session = this.store.get(sessionId);
    if (!session?.backendSession) return;

    session.backendAbort?.abort();
    await session.backendSession.close().catch(() => {});
    session.backendSession = null;
    session.backendAbort = null;

    this.logger.info(`Backend disconnected for session ${sessionId}`);
    this.metrics?.recordEvent({
      timestamp: Date.now(),
      type: "cli:disconnected",
      sessionId,
    });
    this.broadcaster.broadcast(session, { type: "cli_disconnected" });
    this.emit("backend:disconnected", { sessionId, code: 1000, reason: "normal" });
    this.emit("cli:disconnected", { sessionId });

    // Cancel pending permissions
    for (const [reqId] of session.pendingPermissions) {
      this.broadcaster.broadcastToParticipants(session, {
        type: "permission_cancelled",
        request_id: reqId,
      });
    }
    session.pendingPermissions.clear();
  }

  /** Whether a backend session is connected for a given session ID. */
  isBackendConnected(sessionId: string): boolean {
    return !!this.store.get(sessionId)?.backendSession;
  }

  /** Send a UnifiedMessage to the backend session. */
  sendToBackend(sessionId: string, message: UnifiedMessage): void {
    const session = this.store.get(sessionId);
    if (!session?.backendSession) {
      this.logger.warn(`No backend session for ${sessionId}, cannot send message`);
      return;
    }
    try {
      session.backendSession.send(message);
    } catch (err) {
      this.logger.error(`Failed to send to backend for session ${sessionId}`, { error: err });
      this.emit("error", {
        source: "sendToBackend",
        error: err instanceof Error ? err : new Error(String(err)),
        sessionId,
      });
    }
  }

  // ── Backend message consumption ────────────────────────────────────────

  private startBackendConsumption(session: Session, signal: AbortSignal): void {
    const sessionId = session.id;

    // Consume in the background — don't await
    (async () => {
      try {
        if (!session.backendSession) return;
        for await (const msg of session.backendSession.messages) {
          if (signal.aborted) break;
          session.lastActivity = Date.now();
          this.routeUnifiedMessage(session, msg);
        }
      } catch (err) {
        if (signal.aborted) return; // expected shutdown
        this.logger.error(`Backend message stream error for session ${sessionId}`, { error: err });
        this.emit("error", {
          source: "backendConsumption",
          error: err instanceof Error ? err : new Error(String(err)),
          sessionId,
        });
      }

      // Stream ended — backend disconnected (unless we aborted intentionally)
      if (!signal.aborted) {
        session.backendSession = null;
        session.backendAbort = null;
        this.broadcaster.broadcast(session, { type: "cli_disconnected" });
        this.emit("backend:disconnected", { sessionId, code: 1000, reason: "stream ended" });
        this.emit("cli:disconnected", { sessionId });

        for (const [reqId] of session.pendingPermissions) {
          this.broadcaster.broadcastToParticipants(session, {
            type: "permission_cancelled",
            request_id: reqId,
          });
        }
        session.pendingPermissions.clear();
      }
    })();
  }

  // ── Unified message routing ────────────────────────────────────────────

  private routeUnifiedMessage(session: Session, msg: UnifiedMessage): void {
    // Capture previous team state for event diffing
    const prevTeam = session.state.team;

    // Apply state reduction (pure function — no side effects, includes team state)
    session.state = reduceState(session.state, msg, session.teamCorrelationBuffer);

    // Emit team events by diffing previous and new team state (Phase 5.7)
    this.emitTeamEvents(session, prevTeam);

    switch (msg.type) {
      case "session_init":
        this.handleUnifiedSessionInit(session, msg);
        break;
      case "status_change":
        this.handleUnifiedStatusChange(session, msg);
        break;
      case "assistant":
        this.handleUnifiedAssistant(session, msg);
        break;
      case "result":
        this.handleUnifiedResult(session, msg);
        break;
      case "stream_event":
        this.handleUnifiedStreamEvent(session, msg);
        break;
      case "permission_request":
        this.handleUnifiedPermissionRequest(session, msg);
        break;
      case "control_response":
        this.handleUnifiedControlResponse(session, msg);
        break;
      case "tool_progress":
        this.handleUnifiedToolProgress(session, msg);
        break;
      case "tool_use_summary":
        this.handleUnifiedToolUseSummary(session, msg);
        break;
      case "auth_status":
        this.handleUnifiedAuthStatus(session, msg);
        break;
    }
  }

  // ── Team event emission (Phase 5.7) ──────────────────────────────────

  /**
   * Compare previous and current team state, broadcast to consumers, and emit events.
   */
  private emitTeamEvents(session: Session, prevTeam: TeamState | undefined): void {
    const currentTeam = session.state.team;

    // No change
    if (prevTeam === currentTeam) return;

    // Broadcast team state to consumers (works for create, update, and delete).
    // Use null (not undefined) for deletion so JSON.stringify preserves the key.
    this.broadcaster.broadcast(session, {
      type: "session_update",
      session: { team: currentTeam ?? null } as Partial<SessionState>,
    });

    // Diff and emit events
    const events = diffTeamState(session.id, prevTeam, currentTeam);
    for (const event of events) {
      this.emit(event.type, event.payload as BridgeEventMap[typeof event.type]);
    }
  }

  private handleUnifiedSessionInit(session: Session, msg: UnifiedMessage): void {
    const m = msg.metadata;

    // Store backend session ID for resume
    if (m.session_id) {
      session.cliSessionId = m.session_id as string;
      this.emit("backend:session_id", {
        sessionId: session.id,
        backendSessionId: m.session_id as string,
      });
      this.emit("cli:session_id", {
        sessionId: session.id,
        cliSessionId: m.session_id as string,
      });
    }

    // Resolve git info
    if (session.state.cwd && this.gitResolver) {
      const gitInfo = this.gitResolver.resolve(session.state.cwd);
      if (gitInfo) {
        session.state.git_branch = gitInfo.branch;
        session.state.is_worktree = gitInfo.isWorktree;
        session.state.repo_root = gitInfo.repoRoot;
        session.state.git_ahead = gitInfo.ahead ?? 0;
        session.state.git_behind = gitInfo.behind ?? 0;
      }
    }

    // Populate registry from init data (per-session)
    session.registry.clearDynamic();
    if (session.state.slash_commands.length > 0) {
      session.registry.registerFromCLI(
        session.state.slash_commands.map((name: string) => ({ name, description: "" })),
      );
    }
    if (session.state.skills.length > 0) {
      session.registry.registerSkills(session.state.skills);
    }

    this.broadcaster.broadcast(session, {
      type: "session_init",
      session: session.state,
    });
    this.persistSession(session);
    this.sendInitializeRequest(session);
  }

  private autoSendQueuedMessage(session: Session): void {
    if (!session.queuedMessage) return;
    const queued = session.queuedMessage;
    session.queuedMessage = null;
    this.broadcaster.broadcast(session, { type: "queued_message_sent" });
    this.sendUserMessage(session.id, queued.content, {
      images: queued.images,
    });
  }

  private handleUnifiedStatusChange(session: Session, msg: UnifiedMessage): void {
    const status = msg.metadata.status as string | null | undefined;
    session.lastStatus = (status ?? null) as "compacting" | "idle" | "running" | null;
    this.broadcaster.broadcast(session, {
      type: "status_change",
      status: session.lastStatus,
    });

    // Broadcast permissionMode change so frontend can confirm the update
    if (msg.metadata.permissionMode !== undefined && msg.metadata.permissionMode !== null) {
      this.broadcaster.broadcast(session, {
        type: "session_update",
        session: { permissionMode: session.state.permissionMode } as Partial<SessionState>,
      });
    }

    // Auto-send queued message when transitioning to idle
    if (status === "idle") {
      this.autoSendQueuedMessage(session);
    }
  }

  private handleUnifiedAssistant(session: Session, msg: UnifiedMessage): void {
    const m = msg.metadata;
    const consumerMsg: ConsumerMessage = {
      type: "assistant",
      message: {
        id: (m.message_id as string) ?? msg.id,
        type: "message",
        role: "assistant",
        model: (m.model as string) ?? "",
        content: msg.content.map((block) => {
          switch (block.type) {
            case "text":
              return { type: "text" as const, text: block.text };
            case "tool_use":
              return {
                type: "tool_use" as const,
                id: block.id,
                name: block.name,
                input: block.input,
              };
            case "tool_result":
              return {
                type: "tool_result" as const,
                tool_use_id: block.tool_use_id,
                content: block.content,
                is_error: block.is_error,
              };
            default:
              return { type: "text" as const, text: "" };
          }
        }),
        stop_reason: (m.stop_reason as string | null) ?? null,
        usage: (m.usage as {
          input_tokens: number;
          output_tokens: number;
          cache_creation_input_tokens: number;
          cache_read_input_tokens: number;
        }) ?? {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
      parent_tool_use_id: (m.parent_tool_use_id as string | null) ?? null,
    };
    session.messageHistory.push(consumerMsg);
    this.trimMessageHistory(session);
    this.broadcaster.broadcast(session, consumerMsg);
    this.persistSession(session);
  }

  private handleUnifiedResult(session: Session, msg: UnifiedMessage): void {
    const m = msg.metadata;
    const consumerMsg: ConsumerMessage = {
      type: "result",
      data: {
        subtype: m.subtype as string as
          | "success"
          | "error_during_execution"
          | "error_max_turns"
          | "error_max_budget_usd"
          | "error_max_structured_output_retries",
        is_error: (m.is_error as boolean) ?? false,
        result: m.result as string | undefined,
        errors: m.errors as string[] | undefined,
        duration_ms: (m.duration_ms as number) ?? 0,
        duration_api_ms: (m.duration_api_ms as number) ?? 0,
        num_turns: (m.num_turns as number) ?? 0,
        total_cost_usd: (m.total_cost_usd as number) ?? 0,
        stop_reason: (m.stop_reason as string | null) ?? null,
        usage: (m.usage as {
          input_tokens: number;
          output_tokens: number;
          cache_creation_input_tokens: number;
          cache_read_input_tokens: number;
        }) ?? {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        modelUsage: m.modelUsage as
          | Record<
              string,
              {
                inputTokens: number;
                outputTokens: number;
                cacheReadInputTokens: number;
                cacheCreationInputTokens: number;
                contextWindow: number;
                maxOutputTokens: number;
                costUSD: number;
              }
            >
          | undefined,
        total_lines_added: m.total_lines_added as number | undefined,
        total_lines_removed: m.total_lines_removed as number | undefined,
      },
    };
    session.messageHistory.push(consumerMsg);
    this.trimMessageHistory(session);
    this.broadcaster.broadcast(session, consumerMsg);
    this.persistSession(session);

    // Mark session idle — the CLI only sends status_change for "compacting" | null,
    // so the bridge must infer "idle" from result messages (mirrors frontend logic).
    session.lastStatus = "idle";
    this.autoSendQueuedMessage(session);

    // Trigger auto-naming after first turn
    const numTurns = (m.num_turns as number) ?? 0;
    const isError = (m.is_error as boolean) ?? false;
    if (numTurns === 1 && !isError) {
      const firstUserMsg = session.messageHistory.find((msg) => msg.type === "user_message");
      if (firstUserMsg && firstUserMsg.type === "user_message") {
        this.emit("session:first_turn_completed", {
          sessionId: session.id,
          firstUserMessage: firstUserMsg.content,
        });
      }
    }

    // Re-resolve git info — the CLI may have committed, switched branches, etc.
    this.refreshGitInfo(session);
  }

  /** Re-resolve git info and broadcast session_update if anything changed. */
  private refreshGitInfo(session: Session): void {
    if (!session.state.cwd || !this.gitResolver) return;

    const gitInfo = this.gitResolver.resolve(session.state.cwd);
    if (!gitInfo) return;

    const changed =
      session.state.git_branch !== gitInfo.branch ||
      session.state.git_ahead !== (gitInfo.ahead ?? 0) ||
      session.state.git_behind !== (gitInfo.behind ?? 0) ||
      session.state.is_worktree !== gitInfo.isWorktree;

    if (!changed) return;

    session.state.git_branch = gitInfo.branch;
    session.state.is_worktree = gitInfo.isWorktree;
    session.state.repo_root = gitInfo.repoRoot;
    session.state.git_ahead = gitInfo.ahead ?? 0;
    session.state.git_behind = gitInfo.behind ?? 0;

    this.broadcaster.broadcast(session, {
      type: "session_update",
      session: {
        git_branch: session.state.git_branch,
        git_ahead: session.state.git_ahead,
        git_behind: session.state.git_behind,
        is_worktree: session.state.is_worktree,
      } as Partial<SessionState>,
    });
  }

  private handleUnifiedStreamEvent(session: Session, msg: UnifiedMessage): void {
    const m = msg.metadata;
    const event = m.event as { type?: string } | undefined;

    // Derive "running" status from message_start (main session only).
    // The CLI only sends status_change for "compacting" | null — it never
    // reports "running", so the bridge must infer it from stream events.
    if (event?.type === "message_start" && !m.parent_tool_use_id) {
      session.lastStatus = "running";
    }

    this.broadcaster.broadcast(session, {
      type: "stream_event",
      event: m.event,
      parent_tool_use_id: (m.parent_tool_use_id as string | null) ?? null,
    });
  }

  private handleUnifiedPermissionRequest(session: Session, msg: UnifiedMessage): void {
    const m = msg.metadata;

    // Only store can_use_tool permission requests (matches CLI path guard)
    if (m.subtype && m.subtype !== "can_use_tool") return;

    const perm: ConsumerPermissionRequest = {
      request_id: m.request_id as string,
      tool_name: m.tool_name as string,
      input: (m.input as Record<string, unknown>) ?? {},
      permission_suggestions: m.permission_suggestions as unknown[] | undefined,
      description: m.description as string | undefined,
      tool_use_id: m.tool_use_id as string,
      agent_id: m.agent_id as string | undefined,
      timestamp: Date.now(),
    };

    // Store as CLI-compatible PermissionRequest for pendingPermissions map
    const cliPerm: PermissionRequest = {
      ...perm,
      permission_suggestions:
        m.permission_suggestions as PermissionRequest["permission_suggestions"],
    };
    session.pendingPermissions.set(perm.request_id, cliPerm);

    this.broadcaster.broadcastToParticipants(session, {
      type: "permission_request",
      request: perm,
    });
    this.emit("permission:requested", {
      sessionId: session.id,
      request: cliPerm,
    });
    this.persistSession(session);
  }

  private handleUnifiedControlResponse(session: Session, msg: UnifiedMessage): void {
    const m = msg.metadata;

    // Match against pending initialize request
    if (
      !session.pendingInitialize ||
      session.pendingInitialize.requestId !== (m.request_id as string)
    ) {
      return;
    }
    clearTimeout(session.pendingInitialize.timer);
    session.pendingInitialize = null;

    if (m.subtype === "error") {
      this.logger.warn(`Initialize failed: ${m.error}`);
      // Synthesize capabilities from session state (populated by session_init)
      // so consumers still receive capabilities_ready even when the CLI
      // refuses to re-initialize (e.g. "Already initialized").
      if (!session.state.capabilities && session.state.slash_commands.length > 0) {
        const commands = session.state.slash_commands.map((name: string) => ({
          name,
          description: "",
        }));
        this.applyCapabilities(session, commands, [], null);
      }
      return;
    }

    const response = m.response as
      | {
          commands?: unknown[];
          models?: unknown[];
          account?: unknown;
        }
      | undefined;
    if (!response) return;

    const commands = Array.isArray(response.commands)
      ? (response.commands as InitializeCommand[])
      : [];
    const models = Array.isArray(response.models) ? (response.models as InitializeModel[]) : [];
    const account = (response.account as InitializeAccount | null) ?? null;

    this.applyCapabilities(session, commands, models, account);
  }

  private handleUnifiedToolProgress(session: Session, msg: UnifiedMessage): void {
    const m = msg.metadata;
    this.broadcaster.broadcast(session, {
      type: "tool_progress",
      tool_use_id: m.tool_use_id as string,
      tool_name: m.tool_name as string,
      elapsed_time_seconds: m.elapsed_time_seconds as number,
    });
  }

  private handleUnifiedToolUseSummary(session: Session, msg: UnifiedMessage): void {
    const m = msg.metadata;
    this.broadcaster.broadcast(session, {
      type: "tool_use_summary",
      summary: m.summary as string,
      tool_use_ids: m.tool_use_ids as string[],
    });
  }

  private handleUnifiedAuthStatus(session: Session, msg: UnifiedMessage): void {
    const m = msg.metadata;
    const consumerMsg: ConsumerMessage = {
      type: "auth_status",
      isAuthenticating: m.isAuthenticating as boolean,
      output: m.output as string[],
      error: m.error as string | undefined,
    };
    this.broadcaster.broadcast(session, consumerMsg);
    this.emit("auth_status", {
      sessionId: session.id,
      isAuthenticating: m.isAuthenticating as boolean,
      output: m.output as string[],
      error: m.error as string | undefined,
    });
  }
}
