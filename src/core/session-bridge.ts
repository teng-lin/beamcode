import { randomUUID } from "node:crypto";
import { ConsoleLogger } from "../adapters/console-logger.js";
import { translate as translateCLI } from "../adapters/sdk-url/message-translator.js";
import { reduce as reduceState } from "../adapters/sdk-url/state-reducer.js";
import { TokenBucketLimiter } from "../adapters/token-bucket-limiter.js";
import type {
  AuthContext,
  Authenticator,
  ConsumerIdentity,
  ConsumerRole,
} from "../interfaces/auth.js";
import type { CommandRunner } from "../interfaces/command-runner.js";
import type { GitInfoResolver } from "../interfaces/git-resolver.js";
import type { Logger } from "../interfaces/logger.js";
import type { MetricsCollector } from "../interfaces/metrics.js";
import type { RateLimiter } from "../interfaces/rate-limiter.js";
import type { SessionStorage } from "../interfaces/storage.js";
import type { WebSocketLike } from "../interfaces/transport.js";
import { createAnonymousIdentity } from "../types/auth.js";
import type {
  CLIAssistantMessage,
  CLIAuthStatusMessage,
  CLIControlRequestMessage,
  CLIControlResponseMessage,
  CLIMessage,
  CLIResultMessage,
  CLIStreamEventMessage,
  CLISystemInitMessage,
  CLISystemStatusMessage,
  CLIToolProgressMessage,
  CLIToolUseSummaryMessage,
  InitializeAccount,
  InitializeCommand,
  InitializeModel,
  PermissionRequest,
} from "../types/cli-messages.js";
import type { ProviderConfig, ResolvedConfig } from "../types/config.js";
import { resolveConfig } from "../types/config.js";
import type { ConsumerMessage, ConsumerPermissionRequest } from "../types/consumer-messages.js";
import type { BridgeEventMap } from "../types/events.js";
import type { InboundMessage } from "../types/inbound-messages.js";
import type { SessionSnapshot, SessionState } from "../types/session-state.js";
import { parseNDJSON, serializeNDJSON } from "../utils/ndjson.js";
import type { BackendAdapter, BackendSession } from "./interfaces/backend-adapter.js";
import { SlashCommandExecutor } from "./slash-command-executor.js";
import { TeamToolCorrelationBuffer } from "./team-tool-correlation.js";
import { TypedEventEmitter } from "./typed-emitter.js";
import type { TeamState } from "./types/team-types.js";
import type { UnifiedMessage } from "./types/unified-message.js";

// ─── Internal Session ────────────────────────────────────────────────────────

interface Session {
  id: string;
  cliSocket: WebSocketLike | null;
  cliSessionId?: string;
  /** BackendSession from BackendAdapter (coexistence: set when adapter path is used). */
  backendSession: BackendSession | null;
  /** AbortController for the backend message consumption loop. */
  backendAbort: AbortController | null;
  consumerSockets: Map<WebSocketLike, ConsumerIdentity>;
  consumerRateLimiters: Map<WebSocketLike, RateLimiter>; // Per-consumer rate limiting
  anonymousCounter: number;
  state: SessionState;
  pendingPermissions: Map<string, PermissionRequest>;
  messageHistory: ConsumerMessage[];
  pendingMessages: string[];
  lastActivity: number; // Last message time, for idle reaper
  pendingInitialize: {
    requestId: string;
    timer: ReturnType<typeof setTimeout>;
  } | null;
  /** Per-session correlation buffer for team tool_use↔tool_result pairing. */
  teamCorrelationBuffer: TeamToolCorrelationBuffer;
}

function makeDefaultState(sessionId: string): SessionState {
  return {
    session_id: sessionId,
    model: "",
    cwd: "",
    tools: [],
    permissionMode: "default",
    claude_code_version: "",
    mcp_servers: [],
    agents: [],
    slash_commands: [],
    skills: [],
    total_cost_usd: 0,
    num_turns: 0,
    context_used_percent: 0,
    is_compacting: false,
    git_branch: "",
    is_worktree: false,
    repo_root: "",
    git_ahead: 0,
    git_behind: 0,
    total_lines_added: 0,
    total_lines_removed: 0,
  };
}

/** Extract a plain presence entry from a ConsumerIdentity (defensive copy). */
function toPresenceEntry(id: ConsumerIdentity): {
  userId: string;
  displayName: string;
  role: ConsumerRole;
} {
  return { userId: id.userId, displayName: id.displayName, role: id.role };
}

/** Message types that require participant role (observers cannot send these). */
const PARTICIPANT_ONLY_TYPES = new Set([
  "user_message",
  "permission_response",
  "interrupt",
  "set_model",
  "set_permission_mode",
  "slash_command",
]);

// ─── SessionBridge ───────────────────────────────────────────────────────────

export class SessionBridge extends TypedEventEmitter<BridgeEventMap> {
  private sessions = new Map<string, Session>();
  private pendingAuth = new WeakSet<WebSocketLike>();
  private storage: SessionStorage | null;
  private gitResolver: GitInfoResolver | null;
  private authenticator: Authenticator | null;
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
    this.storage = options?.storage ?? null;
    this.gitResolver = options?.gitResolver ?? null;
    this.authenticator = options?.authenticator ?? null;
    this.logger = options?.logger ?? new ConsoleLogger("session-bridge");
    this.config = resolveConfig(options?.config ?? { port: 3456 });
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
    if (!this.storage) return 0;
    const persisted = this.storage.loadAll();
    let count = 0;
    for (const p of persisted) {
      if (this.sessions.has(p.id)) continue; // don't overwrite live sessions
      const session: Session = {
        id: p.id,
        cliSocket: null,
        backendSession: null,
        backendAbort: null,
        consumerSockets: new Map(),
        consumerRateLimiters: new Map(),
        anonymousCounter: 0,
        state: p.state,
        pendingPermissions: new Map(p.pendingPermissions || []),
        messageHistory: p.messageHistory || [],
        pendingMessages: p.pendingMessages || [],
        lastActivity: Date.now(),
        pendingInitialize: null,
        teamCorrelationBuffer: new TeamToolCorrelationBuffer(),
      };
      this.sessions.set(p.id, session);
      count++;
    }
    if (count > 0) {
      this.logger.info(`Restored ${count} session(s) from disk`);
    }
    return count;
  }

  /** Persist a session to disk (debounced). */
  private persistSession(session: Session): void {
    if (!this.storage) return;
    this.storage.save({
      id: session.id,
      state: session.state,
      messageHistory: session.messageHistory,
      pendingMessages: session.pendingMessages,
      pendingPermissions: Array.from(session.pendingPermissions.entries()),
    });
  }

  // ── Session management ───────────────────────────────────────────────────

  getOrCreateSession(sessionId: string): Session {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = {
        id: sessionId,
        cliSocket: null,
        backendSession: null,
        backendAbort: null,
        consumerSockets: new Map(),
        consumerRateLimiters: new Map(),
        anonymousCounter: 0,
        state: makeDefaultState(sessionId),
        pendingPermissions: new Map(),
        messageHistory: [],
        pendingMessages: [],
        lastActivity: Date.now(),
        pendingInitialize: null,
        teamCorrelationBuffer: new TeamToolCorrelationBuffer(),
      };
      this.sessions.set(sessionId, session);
      // Emit metrics event
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
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    return {
      id: session.id,
      state: session.state,
      cliConnected: session.cliSocket !== null,
      consumerCount: session.consumerSockets.size,
      consumers: Array.from(session.consumerSockets.values()).map(toPresenceEntry),
      pendingPermissions: Array.from(session.pendingPermissions.values()),
      messageHistoryLength: session.messageHistory.length,
      lastActivity: session.lastActivity,
    };
  }

  getAllSessions(): SessionState[] {
    return Array.from(this.sessions.values()).map((s) => s.state);
  }

  isCliConnected(sessionId: string): boolean {
    return !!this.sessions.get(sessionId)?.cliSocket;
  }

  removeSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      this.cancelPendingInitialize(session);
    }
    this.sessions.delete(sessionId);
    this.storage?.remove(sessionId);
  }

  /** Close all sockets (CLI + consumers) and backend sessions, then remove. */
  closeSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
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

    this.sessions.delete(sessionId);
    this.storage?.remove(sessionId);
    this.metrics?.recordEvent({
      timestamp: Date.now(),
      type: "session:closed",
      sessionId,
    });
    this.emit("session:closed", { sessionId });
  }

  /** Close all sessions and clear all state (for graceful shutdown). */
  close(): void {
    for (const sessionId of Array.from(this.sessions.keys())) {
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
    this.broadcastToConsumers(session, { type: "cli_connected" });
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
    const session = this.sessions.get(sessionId);
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
    const session = this.sessions.get(sessionId);
    if (!session) return;

    this.cancelPendingInitialize(session);

    session.cliSocket = null;
    this.logger.info(`CLI disconnected for session ${sessionId}`);
    this.metrics?.recordEvent({
      timestamp: Date.now(),
      type: "cli:disconnected",
      sessionId,
    });
    this.broadcastToConsumers(session, { type: "cli_disconnected" });
    this.emit("cli:disconnected", { sessionId });
    this.emit("backend:disconnected", {
      sessionId,
      code: 1000,
      reason: "CLI process disconnected",
    });

    // Cancel any pending permission requests (only participants see these)
    for (const [reqId] of session.pendingPermissions) {
      this.broadcastToParticipants(session, {
        type: "permission_cancelled",
        request_id: reqId,
      });
    }
    session.pendingPermissions.clear();
  }

  // ── Consumer WebSocket handlers ──────────────────────────────────────────

  handleConsumerOpen(ws: WebSocketLike, context: AuthContext): void {
    const session = this.getOrCreateSession(context.sessionId);

    if (this.authenticator) {
      this.pendingAuth.add(ws);
      let authPromise: Promise<ConsumerIdentity>;
      try {
        authPromise = this.authenticator.authenticate(context);
      } catch (err) {
        this.pendingAuth.delete(ws);
        this.rejectConsumer(ws, context.sessionId, err);
        return;
      }

      // Race against auth timeout to prevent hanging connections
      const timeoutMs = this.config.authTimeoutMs;
      let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
      const timeout = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error("Authentication timed out")), timeoutMs);
      });

      Promise.race([authPromise, timeout])
        .then((identity) => {
          // Clean up timeout timer
          if (timeoutHandle) clearTimeout(timeoutHandle);
          if (!this.pendingAuth.delete(ws)) return; // socket closed during auth
          this.acceptConsumer(ws, context.sessionId, identity);
        })
        .catch((err) => {
          // Clean up timeout timer
          if (timeoutHandle) clearTimeout(timeoutHandle);
          if (!this.pendingAuth.delete(ws)) return; // socket closed during auth
          this.rejectConsumer(ws, context.sessionId, err);
        });
    } else {
      session.anonymousCounter++;
      const identity = createAnonymousIdentity(session.anonymousCounter);
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
    const session = this.sessions.get(sessionId);
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
    this.sendToConsumer(ws, {
      type: "identity",
      userId: identity.userId,
      displayName: identity.displayName,
      role: identity.role,
    });

    // Send current session state as snapshot
    this.sendToConsumer(ws, {
      type: "session_init",
      session: session.state,
    });

    // Replay message history so the consumer can reconstruct the conversation
    if (session.messageHistory.length > 0) {
      this.sendToConsumer(ws, {
        type: "message_history",
        messages: session.messageHistory,
      });
    }

    // Send capabilities if already available
    if (session.state.capabilities) {
      this.sendToConsumer(ws, {
        type: "capabilities_ready",
        commands: session.state.capabilities.commands,
        models: session.state.capabilities.models,
        account: session.state.capabilities.account,
      });
    }

    // Send pending permission requests only to participants
    if (identity.role === "participant") {
      for (const perm of session.pendingPermissions.values()) {
        this.sendToConsumer(ws, { type: "permission_request", request: perm });
      }
    }

    // Broadcast presence update to all consumers
    this.broadcastPresence(session);

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

    // Notify if CLI is not connected and request relaunch
    if (!session.cliSocket) {
      this.sendToConsumer(ws, { type: "cli_disconnected" });
      this.logger.info(
        `Consumer connected but CLI is dead for session ${sessionId}, requesting relaunch`,
      );
      this.emit("cli:relaunch_needed", { sessionId });
      this.emit("backend:relaunch_needed", { sessionId });
    }
  }

  handleConsumerMessage(ws: WebSocketLike, sessionId: string, data: string | Buffer): void {
    const raw = typeof data === "string" ? data : data.toString("utf-8");
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.lastActivity = Date.now();

    let msg: InboundMessage;
    try {
      msg = JSON.parse(raw);
    } catch {
      this.logger.warn(`Failed to parse consumer message: ${raw.substring(0, 200)}`);
      return;
    }

    // Reject messages from unregistered sockets (not yet authenticated or already removed)
    const identity = session.consumerSockets.get(ws);
    if (!identity) return;

    // Role-based access control: observers cannot send participant-only messages
    if (identity.role === "observer" && PARTICIPANT_ONLY_TYPES.has(msg.type)) {
      this.sendToConsumer(ws, {
        type: "error",
        message: `Observers cannot send ${msg.type} messages`,
      });
      return;
    }

    // Rate limiting: check if consumer has exceeded message rate limit
    let limiter = session.consumerRateLimiters.get(ws);
    if (!limiter) {
      // Create rate limiter for this consumer (per config)
      const config = this.config.consumerMessageRateLimit ?? {
        burstSize: 20,
        tokensPerSecond: 50,
      };
      limiter = new TokenBucketLimiter(
        config.burstSize,
        1000, // refill every 1 second
        config.tokensPerSecond,
      );
      session.consumerRateLimiters.set(ws, limiter);
    }

    if (!limiter.tryConsume()) {
      this.logger.warn(`Rate limit exceeded for consumer in session ${sessionId}`);
      this.metrics?.recordEvent({
        timestamp: Date.now(),
        type: "ratelimit:exceeded",
        sessionId,
        source: "consumer",
      });
      this.sendToConsumer(ws, {
        type: "error",
        message: "Rate limit exceeded. Please slow down your message rate.",
      });
      return;
    }

    this.emit("message:inbound", { sessionId, message: msg });
    this.routeConsumerMessage(session, msg);
  }

  handleConsumerClose(ws: WebSocketLike, sessionId: string): void {
    this.pendingAuth.delete(ws); // cancel auth in progress
    const session = this.sessions.get(sessionId);
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
    this.broadcastPresence(session);
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
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // Store user message in history for replay
    session.messageHistory.push({
      type: "user_message",
      content,
      timestamp: Date.now(),
    });
    this.trimMessageHistory(session);

    // Build content: if images are present, use content block array; otherwise plain string
    let messageContent: string | unknown[];
    if (options?.images?.length) {
      const blocks: unknown[] = [];
      for (const img of options.images) {
        blocks.push({
          type: "image",
          source: {
            type: "base64",
            media_type: img.media_type,
            data: img.data,
          },
        });
      }
      blocks.push({ type: "text", text: content });
      messageContent = blocks;
    } else {
      messageContent = content;
    }

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
    const session = this.sessions.get(sessionId);
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
    const session = this.sessions.get(sessionId);
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
    switch (msg.type) {
      case "system":
        this.handleSystemMessage(session, msg);
        break;
      case "assistant":
        this.handleAssistantMessage(session, msg);
        break;
      case "result":
        this.handleResultMessage(session, msg);
        break;
      case "stream_event":
        this.handleStreamEvent(session, msg);
        break;
      case "control_request":
        this.handleControlRequest(session, msg);
        break;
      case "control_response":
        this.handleControlResponse(session, msg);
        break;
      case "tool_progress":
        this.handleToolProgress(session, msg);
        break;
      case "tool_use_summary":
        this.handleToolUseSummary(session, msg);
        break;
      case "auth_status":
        this.handleAuthStatus(session, msg);
        break;
      case "keep_alive":
        // Silently consume keepalives
        break;
      default:
        // Forward unknown messages as-is for debugging
        break;
    }
  }

  private handleSystemMessage(
    session: Session,
    msg: CLISystemInitMessage | CLISystemStatusMessage,
  ): void {
    if (msg.subtype === "init") {
      // Store the CLI's internal session_id so we can --resume on relaunch
      if (msg.session_id) {
        session.cliSessionId = msg.session_id;
        this.emit("cli:session_id", {
          sessionId: session.id,
          cliSessionId: msg.session_id,
        });
        this.emit("backend:session_id", {
          sessionId: session.id,
          backendSessionId: msg.session_id,
        });
      }

      session.state.model = msg.model;
      session.state.cwd = msg.cwd;
      session.state.tools = msg.tools;
      session.state.permissionMode = msg.permissionMode;
      session.state.claude_code_version = msg.claude_code_version;
      session.state.mcp_servers = msg.mcp_servers;
      session.state.agents = msg.agents ?? [];
      session.state.slash_commands = msg.slash_commands ?? [];
      session.state.skills = msg.skills ?? [];

      // Resolve git info from session cwd using injected resolver
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

      this.broadcastToConsumers(session, {
        type: "session_init",
        session: session.state,
      });
      this.persistSession(session);
      this.sendInitializeRequest(session);
    } else if (msg.subtype === "status") {
      session.state.is_compacting = msg.status === "compacting";

      if (msg.permissionMode) {
        session.state.permissionMode = msg.permissionMode;
      }

      this.broadcastToConsumers(session, {
        type: "status_change",
        status: msg.status ?? null,
      });
    }
  }

  private handleAssistantMessage(session: Session, msg: CLIAssistantMessage): void {
    // Phase 5.6: Process team tool_use/tool_result in assistant messages
    const unified = translateCLI(msg);
    if (unified) {
      const prevTeam = session.state.team;
      session.state = reduceState(session.state, unified, session.teamCorrelationBuffer);
      this.emitTeamEvents(session, prevTeam);
    }

    const consumerMsg: ConsumerMessage = {
      type: "assistant",
      message: msg.message,
      parent_tool_use_id: msg.parent_tool_use_id,
    };
    session.messageHistory.push(consumerMsg);
    this.trimMessageHistory(session);
    this.broadcastToConsumers(session, consumerMsg);
    this.persistSession(session);
  }

  private handleResultMessage(session: Session, msg: CLIResultMessage): void {
    // Update session cost/turns
    session.state.total_cost_usd = msg.total_cost_usd;
    session.state.num_turns = msg.num_turns;

    // Update lines changed (CLI may send these in result)
    if (typeof msg.total_lines_added === "number") {
      session.state.total_lines_added = msg.total_lines_added;
    }
    if (typeof msg.total_lines_removed === "number") {
      session.state.total_lines_removed = msg.total_lines_removed;
    }

    // Compute context usage from modelUsage and store for slash commands
    if (msg.modelUsage) {
      session.state.last_model_usage = msg.modelUsage;
      for (const usage of Object.values(msg.modelUsage)) {
        if (usage.contextWindow > 0) {
          session.state.context_used_percent = Math.round(
            ((usage.inputTokens + usage.outputTokens) / usage.contextWindow) * 100,
          );
        }
      }
    }
    if (typeof msg.duration_ms === "number") {
      session.state.last_duration_ms = msg.duration_ms;
    }
    if (typeof msg.duration_api_ms === "number") {
      session.state.last_duration_api_ms = msg.duration_api_ms;
    }

    // Extract consumer-relevant fields, stripping CLI transport fields (uuid, session_id, type)
    const consumerMsg: ConsumerMessage = {
      type: "result",
      data: {
        subtype: msg.subtype,
        is_error: msg.is_error,
        result: msg.result,
        errors: msg.errors,
        duration_ms: msg.duration_ms,
        duration_api_ms: msg.duration_api_ms,
        num_turns: msg.num_turns,
        total_cost_usd: msg.total_cost_usd,
        stop_reason: msg.stop_reason,
        usage: msg.usage,
        modelUsage: msg.modelUsage,
        total_lines_added: msg.total_lines_added,
        total_lines_removed: msg.total_lines_removed,
      },
    };
    session.messageHistory.push(consumerMsg);
    this.trimMessageHistory(session);
    this.broadcastToConsumers(session, consumerMsg);
    this.persistSession(session);

    // Trigger auto-naming after first turn completes successfully
    if (msg.num_turns === 1 && !msg.is_error) {
      const firstUserMsg = session.messageHistory.find((m) => m.type === "user_message");
      if (firstUserMsg && firstUserMsg.type === "user_message") {
        this.emit("session:first_turn_completed", {
          sessionId: session.id,
          firstUserMessage: firstUserMsg.content,
        });
      }
    }
  }

  private handleStreamEvent(session: Session, msg: CLIStreamEventMessage): void {
    this.broadcastToConsumers(session, {
      type: "stream_event",
      event: msg.event,
      parent_tool_use_id: msg.parent_tool_use_id,
    });
  }

  private handleControlRequest(session: Session, msg: CLIControlRequestMessage): void {
    if (msg.request.subtype === "can_use_tool") {
      const perm: PermissionRequest = {
        request_id: msg.request_id,
        tool_name: msg.request.tool_name,
        input: msg.request.input,
        permission_suggestions: msg.request.permission_suggestions,
        description: msg.request.description,
        tool_use_id: msg.request.tool_use_id,
        agent_id: msg.request.agent_id,
        timestamp: Date.now(),
      };
      session.pendingPermissions.set(msg.request_id, perm);

      this.broadcastToParticipants(session, {
        type: "permission_request",
        request: perm,
      });
      this.emit("permission:requested", {
        sessionId: session.id,
        request: perm,
      });
      this.persistSession(session);
    }
  }

  private handleToolProgress(session: Session, msg: CLIToolProgressMessage): void {
    this.broadcastToConsumers(session, {
      type: "tool_progress",
      tool_use_id: msg.tool_use_id,
      tool_name: msg.tool_name,
      elapsed_time_seconds: msg.elapsed_time_seconds,
    });
  }

  private handleToolUseSummary(session: Session, msg: CLIToolUseSummaryMessage): void {
    this.broadcastToConsumers(session, {
      type: "tool_use_summary",
      summary: msg.summary,
      tool_use_ids: msg.preceding_tool_use_ids,
    });
  }

  private handleAuthStatus(session: Session, msg: CLIAuthStatusMessage): void {
    const consumerMsg: ConsumerMessage = {
      type: "auth_status",
      isAuthenticating: msg.isAuthenticating,
      output: msg.output,
      error: msg.error,
    };
    this.broadcastToConsumers(session, consumerMsg);
    this.emit("auth_status", {
      sessionId: session.id,
      isAuthenticating: msg.isAuthenticating,
      output: msg.output,
      error: msg.error,
    });
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

  private handleControlResponse(session: Session, msg: CLIControlResponseMessage): void {
    if (
      !session.pendingInitialize ||
      session.pendingInitialize.requestId !== msg.response.request_id
    ) {
      return; // unknown request_id, ignore
    }
    clearTimeout(session.pendingInitialize.timer);
    session.pendingInitialize = null;

    if (msg.response.subtype === "error") {
      this.logger.warn(`Initialize failed: ${msg.response.error}`);
      return;
    }

    const inner = msg.response.response;
    if (!inner) return;

    const commands = Array.isArray(inner.commands) ? inner.commands : [];
    const models = Array.isArray(inner.models) ? inner.models : [];
    const account = inner.account ?? null;

    session.state.capabilities = { commands, models, account, receivedAt: Date.now() };
    this.logger.info(
      `Capabilities received for session ${session.id}: ${commands.length} commands, ${models.length} models`,
    );

    this.broadcastToConsumers(session, { type: "capabilities_ready", commands, models, account });
    this.emit("capabilities:ready", { sessionId: session.id, commands, models, account });
    this.persistSession(session);
  }

  // ── Structured data APIs ───────────────────────────────────────────────

  getSupportedModels(sessionId: string): InitializeModel[] {
    return this.sessions.get(sessionId)?.state.capabilities?.models ?? [];
  }

  getSupportedCommands(sessionId: string): InitializeCommand[] {
    return this.sessions.get(sessionId)?.state.capabilities?.commands ?? [];
  }

  getAccountInfo(sessionId: string): InitializeAccount | null {
    return this.sessions.get(sessionId)?.state.capabilities?.account ?? null;
  }

  // ── Consumer message routing ─────────────────────────────────────────────

  private routeConsumerMessage(session: Session, msg: InboundMessage): void {
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
        this.broadcastPresence(session);
        break;
      case "slash_command":
        this.handleSlashCommand(session, msg);
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

  // ── Slash command handling ───────────────────────────────────────────────

  private handleSlashCommand(
    session: Session,
    msg: { type: "slash_command"; command: string; request_id?: string },
  ): void {
    const { command, request_id } = msg;

    // Native commands are forwarded directly to the CLI as user messages
    if (this.slashCommandExecutor.isNativeCommand(command)) {
      this.sendUserMessage(session.id, command);
      return;
    }

    if (!this.slashCommandExecutor.canHandle(command)) {
      const errorMsg = `Unknown slash command: ${command.split(/\s+/)[0]}`;
      this.broadcastToConsumers(session, {
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
      .execute(session.state, command, session.cliSessionId ?? session.id)
      .then((result) => {
        this.broadcastToConsumers(session, {
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
        this.broadcastToConsumers(session, {
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
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    if (this.slashCommandExecutor.isNativeCommand(command)) {
      this.sendUserMessage(sessionId, command);
      return null; // result comes back via normal CLI message flow
    }

    if (!this.slashCommandExecutor.canHandle(command)) {
      return null;
    }

    const result = await this.slashCommandExecutor.execute(
      session.state,
      command,
      session.cliSessionId ?? session.id,
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
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.broadcastToConsumers(session, {
      type: "session_name_update",
      name,
    });
  }

  private broadcastToConsumers(session: Session, msg: ConsumerMessage): void {
    const json = JSON.stringify(msg);
    const failed: WebSocketLike[] = [];
    for (const ws of session.consumerSockets.keys()) {
      try {
        ws.send(json);
      } catch (err) {
        this.logger.warn(
          `Failed to send message to consumer in session ${session.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
        failed.push(ws);
      }
    }
    for (const ws of failed) {
      session.consumerSockets.delete(ws);
    }
    this.emit("message:outbound", { sessionId: session.id, message: msg });
  }

  private broadcastToParticipants(session: Session, msg: ConsumerMessage): void {
    const json = JSON.stringify(msg);
    const failed: WebSocketLike[] = [];
    for (const [ws, identity] of session.consumerSockets.entries()) {
      if (identity.role !== "participant") continue;
      try {
        ws.send(json);
      } catch (err) {
        this.logger.warn(
          `Failed to send message to participant in session ${session.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
        failed.push(ws);
      }
    }
    for (const ws of failed) {
      session.consumerSockets.delete(ws);
    }
    this.emit("message:outbound", { sessionId: session.id, message: msg });
  }

  private sendToConsumer(ws: WebSocketLike, msg: ConsumerMessage): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // Socket will be cleaned up on close
    }
  }

  // ── Presence ─────────────────────────────────────────────────────────────

  private broadcastPresence(session: Session): void {
    const consumers = Array.from(session.consumerSockets.values()).map(toPresenceEntry);
    this.broadcastToConsumers(session, { type: "presence_update", consumers });
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
    this.broadcastToConsumers(session, { type: "cli_connected" });
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
    const session = this.sessions.get(sessionId);
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
    this.broadcastToConsumers(session, { type: "cli_disconnected" });
    this.emit("backend:disconnected", { sessionId, code: 1000, reason: "normal" });
    this.emit("cli:disconnected", { sessionId });

    // Cancel pending permissions
    for (const [reqId] of session.pendingPermissions) {
      this.broadcastToParticipants(session, {
        type: "permission_cancelled",
        request_id: reqId,
      });
    }
    session.pendingPermissions.clear();
  }

  /** Whether a backend session is connected for a given session ID. */
  isBackendConnected(sessionId: string): boolean {
    return !!this.sessions.get(sessionId)?.backendSession;
  }

  /** Send a UnifiedMessage to the backend session. */
  sendToBackend(sessionId: string, message: UnifiedMessage): void {
    const session = this.sessions.get(sessionId);
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
        this.broadcastToConsumers(session, { type: "cli_disconnected" });
        this.emit("backend:disconnected", { sessionId, code: 1000, reason: "stream ended" });
        this.emit("cli:disconnected", { sessionId });

        for (const [reqId] of session.pendingPermissions) {
          this.broadcastToParticipants(session, {
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
   * Compare previous and current team state and emit appropriate events.
   */
  private emitTeamEvents(session: Session, prevTeam: TeamState | undefined): void {
    const currentTeam = session.state.team;
    const sessionId = session.id;

    // No change
    if (prevTeam === currentTeam) return;

    // Team created
    if (!prevTeam && currentTeam) {
      this.emit("team:created", { sessionId, teamName: currentTeam.name });
      return;
    }

    // Team deleted
    if (prevTeam && !currentTeam) {
      this.emit("team:deleted", { sessionId, teamName: prevTeam.name });
      return;
    }

    // Both exist — diff members and tasks
    if (prevTeam && currentTeam) {
      this.diffTeamMembers(sessionId, prevTeam, currentTeam);
      this.diffTeamTasks(sessionId, prevTeam, currentTeam);
    }
  }

  private diffTeamMembers(sessionId: string, prev: TeamState, current: TeamState): void {
    const prevNames = new Set(prev.members.map((m) => m.name));

    for (const member of current.members) {
      if (!prevNames.has(member.name)) {
        this.emit("team:member:joined", { sessionId, member });
        continue;
      }

      const prevMember = prev.members.find((m) => m.name === member.name);
      if (!prevMember) continue;

      if (prevMember.status !== member.status) {
        if (member.status === "idle") {
          this.emit("team:member:idle", { sessionId, member });
        } else if (member.status === "shutdown") {
          this.emit("team:member:shutdown", { sessionId, member });
        }
      }
    }
  }

  private diffTeamTasks(sessionId: string, prev: TeamState, current: TeamState): void {
    const prevTaskMap = new Map(prev.tasks.map((t) => [t.id, t]));

    for (const task of current.tasks) {
      const prevTask = prevTaskMap.get(task.id);
      if (!prevTask) {
        this.emit("team:task:created", { sessionId, task });
        continue;
      }

      if (prevTask.status !== task.status) {
        if (task.status === "in_progress" && task.owner) {
          this.emit("team:task:claimed", { sessionId, task });
        } else if (task.status === "completed") {
          this.emit("team:task:completed", { sessionId, task });
        }
      }
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

    this.broadcastToConsumers(session, {
      type: "session_init",
      session: session.state,
    });
    this.persistSession(session);
    this.sendInitializeRequest(session);
  }

  private handleUnifiedStatusChange(session: Session, msg: UnifiedMessage): void {
    const status = msg.metadata.status as string | null | undefined;
    this.broadcastToConsumers(session, {
      type: "status_change",
      status: (status ?? null) as "compacting" | "idle" | "running" | null,
    });
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
    this.broadcastToConsumers(session, consumerMsg);
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
    this.broadcastToConsumers(session, consumerMsg);
    this.persistSession(session);

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
  }

  private handleUnifiedStreamEvent(session: Session, msg: UnifiedMessage): void {
    const m = msg.metadata;
    this.broadcastToConsumers(session, {
      type: "stream_event",
      event: m.event,
      parent_tool_use_id: (m.parent_tool_use_id as string | null) ?? null,
    });
  }

  private handleUnifiedPermissionRequest(session: Session, msg: UnifiedMessage): void {
    const m = msg.metadata;
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

    this.broadcastToParticipants(session, {
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

    session.state.capabilities = { commands, models, account, receivedAt: Date.now() };
    this.logger.info(
      `Capabilities received for session ${session.id}: ${commands.length} commands, ${models.length} models`,
    );

    this.broadcastToConsumers(session, { type: "capabilities_ready", commands, models, account });
    this.emit("capabilities:ready", { sessionId: session.id, commands, models, account });
    this.persistSession(session);
  }

  private handleUnifiedToolProgress(session: Session, msg: UnifiedMessage): void {
    const m = msg.metadata;
    this.broadcastToConsumers(session, {
      type: "tool_progress",
      tool_use_id: m.tool_use_id as string,
      tool_name: m.tool_name as string,
      elapsed_time_seconds: m.elapsed_time_seconds as number,
    });
  }

  private handleUnifiedToolUseSummary(session: Session, msg: UnifiedMessage): void {
    const m = msg.metadata;
    this.broadcastToConsumers(session, {
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
    this.broadcastToConsumers(session, consumerMsg);
    this.emit("auth_status", {
      sessionId: session.id,
      isAuthenticating: m.isAuthenticating as boolean,
      output: m.output as string[],
      error: m.error as string | undefined,
    });
  }
}
