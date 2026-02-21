import type { ConsumerIdentity } from "../interfaces/auth.js";
import type { RateLimiter } from "../interfaces/rate-limiter.js";
import type { WebSocketLike } from "../interfaces/transport.js";
import type {
  InitializeAccount,
  InitializeCommand,
  InitializeModel,
  PermissionRequest,
} from "../types/cli-messages.js";
import type { ConsumerMessage } from "../types/consumer-messages.js";
import type { SessionSnapshot } from "../types/session-state.js";
import type { ConsumerBroadcaster } from "./consumer-broadcaster.js";
import type { InboundCommand, PolicyCommand } from "./interfaces/runtime-commands.js";
import type { MessageQueueHandler } from "./message-queue-handler.js";
import type { LifecycleState } from "./session-lifecycle.js";
import { isLifecycleTransitionAllowed } from "./session-lifecycle.js";
import type { Session } from "./session-repository.js";
import type { SlashCommandService } from "./slash-command-service.js";
import type { UnifiedMessage } from "./types/unified-message.js";

export type RuntimeTraceInfo = {
  traceId?: string;
  requestId?: string;
  command?: string;
};

type RuntimeSendUserMessageOptions = {
  sessionIdOverride?: string;
  images?: { media_type: string; data: string }[];
  traceId?: string;
  slashRequestId?: string;
  slashCommand?: string;
};

type RuntimeSendPermissionOptions = {
  updatedInput?: Record<string, unknown>;
  updatedPermissions?: unknown[];
  message?: string;
};

export type RuntimeShadowParityState = {
  backendConnected: boolean;
  backendSessionId: string | undefined;
  lastStatus: Session["lastStatus"];
};

export interface SessionRuntimeDeps {
  now: () => number;
  maxMessageHistoryLength: number;
  broadcaster: Pick<ConsumerBroadcaster, "broadcast" | "broadcastPresence" | "sendTo">;
  queueHandler: Pick<
    MessageQueueHandler,
    "handleQueueMessage" | "handleUpdateQueuedMessage" | "handleCancelQueuedMessage"
  >;
  slashService: Pick<SlashCommandService, "handleInbound" | "executeProgrammatic">;
  sendToBackend: (session: Session, message: UnifiedMessage) => void;
  tracedNormalizeInbound: (
    session: Session,
    msg: InboundCommand,
    trace?: RuntimeTraceInfo,
  ) => UnifiedMessage | null;
  persistSession: (session: Session) => void;
  warnUnknownPermission: (sessionId: string, requestId: string) => void;
  emitPermissionResolved: (
    sessionId: string,
    requestId: string,
    behavior: "allow" | "deny",
  ) => void;
  onSessionSeeded?: (session: Session) => void;
  onInvalidLifecycleTransition?: (params: {
    sessionId: string;
    from: LifecycleState;
    to: LifecycleState;
    reason: string;
  }) => void;
  onInboundObserved?: (session: Session, msg: InboundCommand) => void;
  onInboundHandled?: (session: Session, msg: InboundCommand) => void;
  onBackendMessageObserved?: (session: Session, msg: UnifiedMessage) => void;
  routeBackendMessage?: (session: Session, msg: UnifiedMessage) => void;
  onBackendMessageHandled?: (session: Session, msg: UnifiedMessage) => void;
  onSignal?: (
    session: Session,
    signal: "backend:connected" | "backend:disconnected" | "session:closed",
  ) => void;
}

export class SessionRuntime {
  private lifecycle: LifecycleState = "awaiting_backend";

  constructor(
    private readonly session: Session,
    private readonly deps: SessionRuntimeDeps,
  ) {
    this.hydrateSlashRegistryFromState();
  }

  getLifecycleState(): LifecycleState {
    return this.lifecycle;
  }

  getSessionSnapshot(): SessionSnapshot {
    return {
      id: this.session.id,
      state: this.session.state,
      lifecycle: this.lifecycle,
      cliConnected: this.session.backendSession !== null,
      consumerCount: this.session.consumerSockets.size,
      consumers: Array.from(this.session.consumerSockets.values()).map((id) => ({
        userId: id.userId,
        displayName: id.displayName,
        role: id.role,
      })),
      pendingPermissions: Array.from(this.session.pendingPermissions.values()),
      messageHistoryLength: this.session.messageHistory.length,
      lastActivity: this.session.lastActivity,
      lastStatus: this.session.lastStatus,
    };
  }

  getSupportedModels(): InitializeModel[] {
    return this.session.state.capabilities?.models ?? [];
  }

  getSupportedCommands(): InitializeCommand[] {
    return this.session.state.capabilities?.commands ?? [];
  }

  getAccountInfo(): InitializeAccount | null {
    return this.session.state.capabilities?.account ?? null;
  }

  setAdapterName(name: string): void {
    this.session.adapterName = name;
    this.session.state.adapterName = name;
    this.deps.persistSession(this.session);
  }

  getLastStatus(): Session["lastStatus"] {
    return this.session.lastStatus;
  }

  getState(): Session["state"] {
    return this.session.state;
  }

  setLastStatus(status: Session["lastStatus"]): void {
    this.session.lastStatus = status;
  }

  setState(state: Session["state"]): void {
    this.session.state = state;
  }

  setBackendSessionId(sessionId: string | undefined): void {
    this.session.backendSessionId = sessionId;
  }

  getMessageHistory(): Session["messageHistory"] {
    return this.session.messageHistory;
  }

  setMessageHistory(history: Session["messageHistory"]): void {
    this.session.messageHistory = history;
  }

  getQueuedMessage(): Session["queuedMessage"] {
    return this.session.queuedMessage;
  }

  setQueuedMessage(queued: Session["queuedMessage"]): void {
    this.session.queuedMessage = queued;
  }

  getPendingPermissions(): PermissionRequest[] {
    return Array.from(this.session.pendingPermissions.values());
  }

  getPendingInitialize(): Session["pendingInitialize"] {
    return this.session.pendingInitialize;
  }

  getConsumerIdentity(ws: WebSocketLike): ConsumerIdentity | undefined {
    return this.session.consumerSockets.get(ws);
  }

  getConsumerCount(): number {
    return this.session.consumerSockets.size;
  }

  getConsumerSockets(): ReadonlyMap<WebSocketLike, ConsumerIdentity> {
    return this.session.consumerSockets;
  }

  getShadowParityState(): RuntimeShadowParityState {
    return {
      backendConnected: this.session.backendSession !== null,
      backendSessionId: this.session.backendSessionId,
      lastStatus: this.session.lastStatus,
    };
  }

  getBackendSession(): Session["backendSession"] {
    return this.session.backendSession;
  }

  getBackendAbort(): Session["backendAbort"] {
    return this.session.backendAbort;
  }

  isBackendConnected(): boolean {
    return this.session.backendSession !== null;
  }

  setPendingInitialize(pendingInitialize: Session["pendingInitialize"]): void {
    this.session.pendingInitialize = pendingInitialize;
  }

  trySendRawToBackend(ndjson: string): "sent" | "unsupported" | "no_backend" {
    const backendSession = this.session.backendSession;
    if (!backendSession) return "no_backend";
    try {
      backendSession.sendRaw(ndjson);
      return "sent";
    } catch {
      return "unsupported";
    }
  }

  registerCLICommands(commands: InitializeCommand[]): void {
    this.session.registry.registerFromCLI?.(commands);
  }

  registerSlashCommandNames(commands: string[]): void {
    if (commands.length === 0) return;
    this.registerCLICommands(commands.map((name) => ({ name, description: "" })));
  }

  registerSkillCommands(skills: string[]): void {
    if (skills.length === 0) return;
    this.session.registry.registerSkills?.(skills);
  }

  clearDynamicSlashRegistry(): void {
    this.session.registry.clearDynamic?.();
  }

  seedSessionState(params: { cwd?: string; model?: string }): void {
    if (params.cwd) this.session.state.cwd = params.cwd;
    if (params.model) this.session.state.model = params.model;
    this.deps.onSessionSeeded?.(this.session);
  }

  allocateAnonymousIdentityIndex(): number {
    this.session.anonymousCounter += 1;
    return this.session.anonymousCounter;
  }

  addConsumer(ws: WebSocketLike, identity: ConsumerIdentity): void {
    this.session.consumerSockets.set(ws, identity);
  }

  removeConsumer(ws: WebSocketLike): ConsumerIdentity | undefined {
    const identity = this.session.consumerSockets.get(ws);
    this.session.consumerSockets.delete(ws);
    this.session.consumerRateLimiters.delete(ws);
    return identity;
  }

  closeAllConsumers(): void {
    for (const ws of this.session.consumerSockets.keys()) {
      try {
        ws.close();
      } catch {
        // Ignore close errors for defensive shutdown.
      }
      this.removeConsumer(ws);
    }
  }

  async closeBackendConnection(): Promise<void> {
    const backendSession = this.session.backendSession;
    if (!backendSession) return;
    this.session.backendAbort?.abort();
    await backendSession.close();
    this.clearBackendConnection();
  }

  clearBackendConnection(): void {
    this.session.backendSession = null;
    this.session.backendAbort = null;
  }

  attachBackendConnection(params: {
    backendSession: NonNullable<Session["backendSession"]>;
    backendAbort: AbortController;
    supportsSlashPassthrough: boolean;
    slashExecutor: Session["adapterSlashExecutor"] | null;
  }): void {
    this.session.backendSession = params.backendSession;
    this.session.backendAbort = params.backendAbort;
    this.session.adapterSupportsSlashPassthrough = params.supportsSlashPassthrough;
    this.session.adapterSlashExecutor = params.slashExecutor;
  }

  resetBackendConnectionState(): void {
    this.clearBackendConnection();
    this.session.backendSessionId = undefined;
    this.session.adapterSupportsSlashPassthrough = false;
    this.session.adapterSlashExecutor = null;
  }

  drainPendingMessages(): UnifiedMessage[] {
    const pending = this.session.pendingMessages;
    this.session.pendingMessages = [];
    return pending;
  }

  drainPendingPermissionIds(): string[] {
    const ids = Array.from(this.session.pendingPermissions.keys());
    this.session.pendingPermissions.clear();
    return ids;
  }

  storePendingPermission(requestId: string, request: PermissionRequest): void {
    this.session.pendingPermissions.set(requestId, request);
  }

  enqueuePendingPassthrough(entry: Session["pendingPassthroughs"][number]): void {
    this.session.pendingPassthroughs.push(entry);
  }

  peekPendingPassthrough(): Session["pendingPassthroughs"][number] | undefined {
    return this.session.pendingPassthroughs[0];
  }

  shiftPendingPassthrough(): Session["pendingPassthroughs"][number] | undefined {
    return this.session.pendingPassthroughs.shift();
  }

  checkRateLimit(ws: WebSocketLike, createLimiter: () => RateLimiter | undefined): boolean {
    let limiter = this.session.consumerRateLimiters.get(ws);
    if (!limiter) {
      limiter = createLimiter();
      if (!limiter) return true;
      this.session.consumerRateLimiters.set(ws, limiter);
    }
    return limiter.tryConsume();
  }

  transitionLifecycle(next: LifecycleState, reason: string): void {
    const current = this.lifecycle;
    if (current === next) return;
    if (!isLifecycleTransitionAllowed(current, next)) {
      this.deps.onInvalidLifecycleTransition?.({
        sessionId: this.session.id,
        from: current,
        to: next,
        reason,
      });
    }
    this.lifecycle = next;
  }

  handleInboundCommand(msg: InboundCommand, ws: WebSocketLike): void {
    this.touchActivity();
    this.deps.onInboundObserved?.(this.session, msg);
    switch (msg.type) {
      case "user_message":
        // Preserve legacy optimistic running behavior for queue decisions.
        this.session.lastStatus = "running";
        this.sendUserMessage(msg.content, {
          sessionIdOverride: msg.session_id,
          images: msg.images,
        });
        break;
      case "permission_response":
        this.sendPermissionResponse(msg.request_id, msg.behavior, {
          updatedInput: msg.updated_input,
          updatedPermissions: msg.updated_permissions,
          message: msg.message,
        });
        break;
      case "interrupt":
        this.sendInterrupt();
        break;
      case "set_model":
        this.sendSetModel(msg.model);
        break;
      case "set_permission_mode":
        this.sendSetPermissionMode(msg.mode);
        break;
      case "presence_query":
        this.deps.broadcaster.broadcastPresence(this.session);
        break;
      case "slash_command":
        this.handleSlashCommand(msg);
        break;
      case "queue_message":
        this.deps.queueHandler.handleQueueMessage(this.session, msg, ws);
        break;
      case "update_queued_message":
        this.deps.queueHandler.handleUpdateQueuedMessage(this.session, msg, ws);
        break;
      case "cancel_queued_message":
        this.deps.queueHandler.handleCancelQueuedMessage(this.session, ws);
        break;
      case "set_adapter":
        this.deps.broadcaster.sendTo(ws, {
          type: "error",
          message:
            "Adapter cannot be changed on an active session. Create a new session with the desired adapter.",
        });
        break;
    }
    this.deps.onInboundHandled?.(this.session, msg);
  }

  sendUserMessage(content: string, options?: RuntimeSendUserMessageOptions): void {
    const userMsg: ConsumerMessage = {
      type: "user_message",
      content,
      timestamp: this.deps.now(),
    };
    this.session.messageHistory.push(userMsg);
    this.trimMessageHistory();
    this.deps.broadcaster.broadcast(this.session, userMsg);

    const unified = this.deps.tracedNormalizeInbound(
      this.session,
      {
        type: "user_message",
        content,
        session_id: options?.sessionIdOverride || this.session.backendSessionId || "",
        images: options?.images,
      },
      {
        traceId: options?.traceId,
        requestId: options?.slashRequestId,
        command: options?.slashCommand,
      },
    );
    if (!unified) return;

    if (this.session.backendSession) {
      this.transitionLifecycle("active", "inbound:user_message");
      this.session.backendSession.send(unified);
    } else {
      this.session.pendingMessages.push(unified);
      this.transitionLifecycle("awaiting_backend", "inbound:user_message:queued");
    }
    this.deps.persistSession(this.session);
  }

  private trimMessageHistory(): void {
    const maxLength = this.deps.maxMessageHistoryLength;
    if (this.session.messageHistory.length > maxLength) {
      this.session.messageHistory = this.session.messageHistory.slice(-maxLength);
    }
  }

  sendPermissionResponse(
    requestId: string,
    behavior: "allow" | "deny",
    options?: RuntimeSendPermissionOptions,
  ): void {
    const pending = this.session.pendingPermissions.get(requestId);
    if (!pending) {
      this.deps.warnUnknownPermission(this.session.id, requestId);
      return;
    }
    this.session.pendingPermissions.delete(requestId);
    this.deps.emitPermissionResolved(this.session.id, requestId, behavior);

    if (!this.session.backendSession) return;
    const unified = this.deps.tracedNormalizeInbound(this.session, {
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
      this.session.backendSession.send(unified);
    }
  }

  sendInterrupt(): void {
    this.sendControlRequest({ type: "interrupt" });
  }

  sendSetModel(model: string): void {
    this.sendControlRequest({ type: "set_model", model });
  }

  sendSetPermissionMode(mode: string): void {
    this.sendControlRequest({ type: "set_permission_mode", mode });
  }

  handlePolicyCommand(command: PolicyCommand): void {
    switch (command.type) {
      case "reconnect_timeout":
        this.transitionLifecycle("degraded", "policy:reconnect_timeout");
        break;
      case "idle_reap":
        this.transitionLifecycle("closing", "policy:idle_reap");
        break;
      case "capabilities_timeout":
        // Capabilities timeout is advisory; no direct state mutation yet.
        break;
    }
  }

  async executeSlashCommand(
    command: string,
  ): Promise<{ content: string; source: "emulated" } | null> {
    return this.deps.slashService.executeProgrammatic(this.session, command);
  }

  sendToBackend(message: UnifiedMessage): void {
    this.deps.sendToBackend(this.session, message);
  }

  private sendControlRequest(msg: InboundCommand): void {
    if (!this.session.backendSession) return;
    const unified = this.deps.tracedNormalizeInbound(this.session, msg);
    if (unified) {
      this.session.backendSession.send(unified);
    }
  }

  handleBackendMessage(msg: UnifiedMessage): void {
    this.touchActivity();
    this.deps.onBackendMessageObserved?.(this.session, msg);
    this.deps.routeBackendMessage?.(this.session, msg);
    this.applyLifecycleFromBackendMessage(msg);
    this.deps.onBackendMessageHandled?.(this.session, msg);
  }

  handleSignal(signal: "backend:connected" | "backend:disconnected" | "session:closed"): void {
    if (signal === "backend:connected") {
      this.transitionLifecycle("active", "signal:backend:connected");
    } else if (signal === "backend:disconnected") {
      this.transitionLifecycle("degraded", "signal:backend:disconnected");
    } else if (signal === "session:closed") {
      this.transitionLifecycle("closed", "signal:session:closed");
    }
    this.deps.onSignal?.(this.session, signal);
  }

  private handleSlashCommand(msg: Extract<InboundCommand, { type: "slash_command" }>): void {
    this.deps.slashService.handleInbound(this.session, msg);
  }

  private applyLifecycleFromBackendMessage(msg: UnifiedMessage): void {
    if (msg.type === "status_change") {
      const status = typeof msg.metadata.status === "string" ? msg.metadata.status : null;
      if (status === "idle") {
        this.transitionLifecycle("idle", "backend:status_change:idle");
      } else if (status === "running" || status === "compacting") {
        this.transitionLifecycle("active", `backend:status_change:${status}`);
      }
      return;
    }

    if (msg.type === "result") {
      this.transitionLifecycle("idle", "backend:result");
      return;
    }

    if (msg.type === "stream_event") {
      const event = msg.metadata.event as { type?: unknown } | undefined;
      if (event?.type === "message_start" && !msg.metadata.parent_tool_use_id) {
        this.transitionLifecycle("active", "backend:stream_event:message_start");
      }
    }
  }

  private touchActivity(): void {
    this.session.lastActivity = this.deps.now();
  }

  private hydrateSlashRegistryFromState(): void {
    this.clearDynamicSlashRegistry();
    this.registerSlashCommandNames(this.session.state.slash_commands ?? []);
    this.registerSkillCommands(this.session.state.skills ?? []);
  }
}
