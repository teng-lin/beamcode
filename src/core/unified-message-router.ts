/**
 * UnifiedMessageRouter — T4 translation boundary (UnifiedMessage → ConsumerMessage).
 *
 * Routes backend UnifiedMessages to the appropriate handler: applies state
 * reduction, persists to message history, and broadcasts ConsumerMessages to
 * connected consumers. Decides what reaches consumers (e.g. text_delta,
 * tool_use) vs. what is handled internally (e.g. session_lifecycle,
 * control_response).
 *
 * Exposes a single `route(session, msg)` entry point.
 */

import type { GitInfoResolver } from "../interfaces/git-resolver.js";
import type {
  InitializeAccount,
  InitializeCommand,
  InitializeModel,
  PermissionRequest,
} from "../types/cli-messages.js";
import { CONSUMER_PROTOCOL_VERSION, type ConsumerMessage } from "../types/consumer-messages.js";
import type { BridgeEventMap } from "../types/events.js";
import type { SessionState } from "../types/session-state.js";
import type { CapabilitiesPolicy } from "./capabilities-policy.js";
import type { ConsumerBroadcaster } from "./consumer-broadcaster.js";
import {
  mapAssistantMessage,
  mapAuthStatus,
  mapConfigurationChange,
  mapPermissionRequest,
  mapResultMessage,
  mapSessionLifecycle,
  mapStreamEvent,
  mapToolProgress,
  mapToolUseSummary,
} from "./consumer-message-mapper.js";
import { applyGitInfo, type GitInfoTracker } from "./git-info-tracker.js";
import type { MessageQueueHandler } from "./message-queue-handler.js";
import { extractTraceContext, type MessageTracer } from "./message-tracer.js";
import type { Session } from "./session-repository.js";
import { reduce as reduceState } from "./session-state-reducer.js";
import { diffTeamState } from "./team-event-differ.js";
import type { TeamState } from "./types/team-types.js";
import type { UnifiedMessage } from "./types/unified-message.js";

// ─── Dependency contracts ────────────────────────────────────────────────────

type EmitEvent = (type: string, payload: unknown) => void;
type PersistSession = (session: Session) => void;

/** Trace context threaded through the route() call to each handler. */
interface RouteTrace {
  sessionId: string;
  traceId?: string;
  requestId?: string;
  command?: string;
  phase: string;
}

export interface UnifiedMessageRouterDeps {
  broadcaster: ConsumerBroadcaster;
  capabilitiesPolicy: CapabilitiesPolicy;
  queueHandler: MessageQueueHandler;
  gitTracker: GitInfoTracker;
  gitResolver: GitInfoResolver | null;
  emitEvent: EmitEvent;
  persistSession: PersistSession;
  maxMessageHistoryLength: number;
  tracer: MessageTracer;
  getState: (session: Session) => Session["state"];
  setState: (session: Session, state: Session["state"]) => void;
  setBackendSessionId: (session: Session, backendSessionId: string | undefined) => void;
  getMessageHistory: (session: Session) => Session["messageHistory"];
  setMessageHistory: (session: Session, history: Session["messageHistory"]) => void;
  getLastStatus: (session: Session) => Session["lastStatus"];
  setLastStatus: (session: Session, status: Session["lastStatus"]) => void;
  storePendingPermission: (session: Session, requestId: string, request: PermissionRequest) => void;
  clearDynamicSlashRegistry: (session: Session) => void;
  registerCLICommands: (session: Session, commands: InitializeCommand[]) => void;
  registerSkillCommands: (session: Session, skills: string[]) => void;
}

// ─── UnifiedMessageRouter ────────────────────────────────────────────────────

export class UnifiedMessageRouter {
  private broadcaster: ConsumerBroadcaster;
  private capabilitiesPolicy: CapabilitiesPolicy;
  private queueHandler: MessageQueueHandler;
  private gitTracker: GitInfoTracker;
  private gitResolver: GitInfoResolver | null;
  private emitEvent: EmitEvent;
  private persistSession: PersistSession;
  private maxMessageHistoryLength: number;
  private tracer: MessageTracer;
  private getStateAccessor: UnifiedMessageRouterDeps["getState"];
  private setStateAccessor: UnifiedMessageRouterDeps["setState"];
  private setBackendSessionIdAccessor: UnifiedMessageRouterDeps["setBackendSessionId"];
  private getMessageHistoryAccessor: UnifiedMessageRouterDeps["getMessageHistory"];
  private setMessageHistoryAccessor: UnifiedMessageRouterDeps["setMessageHistory"];
  private getLastStatusAccessor: UnifiedMessageRouterDeps["getLastStatus"];
  private setLastStatusAccessor: UnifiedMessageRouterDeps["setLastStatus"];
  private storePendingPermissionAccessor: UnifiedMessageRouterDeps["storePendingPermission"];
  private clearDynamicSlashRegistryAccessor: UnifiedMessageRouterDeps["clearDynamicSlashRegistry"];
  private registerCLICommandsAccessor: UnifiedMessageRouterDeps["registerCLICommands"];
  private registerSkillCommandsAccessor: UnifiedMessageRouterDeps["registerSkillCommands"];

  constructor(deps: UnifiedMessageRouterDeps) {
    this.broadcaster = deps.broadcaster;
    this.capabilitiesPolicy = deps.capabilitiesPolicy;
    this.queueHandler = deps.queueHandler;
    this.gitTracker = deps.gitTracker;
    this.gitResolver = deps.gitResolver;
    this.emitEvent = deps.emitEvent;
    this.persistSession = deps.persistSession;
    this.maxMessageHistoryLength = deps.maxMessageHistoryLength;
    this.tracer = deps.tracer;
    this.getStateAccessor = deps.getState;
    this.setStateAccessor = deps.setState;
    this.setBackendSessionIdAccessor = deps.setBackendSessionId;
    this.getMessageHistoryAccessor = deps.getMessageHistory;
    this.setMessageHistoryAccessor = deps.setMessageHistory;
    this.getLastStatusAccessor = deps.getLastStatus;
    this.setLastStatusAccessor = deps.setLastStatus;
    this.storePendingPermissionAccessor = deps.storePendingPermission;
    this.clearDynamicSlashRegistryAccessor = deps.clearDynamicSlashRegistry;
    this.registerCLICommandsAccessor = deps.registerCLICommands;
    this.registerSkillCommandsAccessor = deps.registerSkillCommands;
  }

  private getState(session: Session): Session["state"] {
    return this.getStateAccessor(session);
  }

  private setState(session: Session, state: Session["state"]): void {
    this.setStateAccessor(session, state);
  }

  private setBackendSessionId(session: Session, backendSessionId: string | undefined): void {
    this.setBackendSessionIdAccessor(session, backendSessionId);
  }

  private getMessageHistory(session: Session): Session["messageHistory"] {
    return this.getMessageHistoryAccessor(session);
  }

  private setMessageHistory(session: Session, history: Session["messageHistory"]): void {
    this.setMessageHistoryAccessor(session, history);
  }

  private getLastStatus(session: Session): Session["lastStatus"] {
    return this.getLastStatusAccessor(session);
  }

  private setLastStatus(session: Session, status: Session["lastStatus"]): void {
    this.setLastStatusAccessor(session, status);
  }

  private storePendingPermission(
    session: Session,
    requestId: string,
    request: PermissionRequest,
  ): void {
    this.storePendingPermissionAccessor(session, requestId, request);
  }

  private clearDynamicSlashRegistry(session: Session): void {
    this.clearDynamicSlashRegistryAccessor(session);
  }

  private registerCLICommands(session: Session, commands: InitializeCommand[]): void {
    this.registerCLICommandsAccessor(session, commands);
  }

  private registerSkillCommands(session: Session, skills: string[]): void {
    this.registerSkillCommandsAccessor(session, skills);
  }

  /** Route a UnifiedMessage through state reduction and the appropriate handler. */
  route(session: Session, msg: UnifiedMessage): void {
    const { traceId, requestId, command } = extractTraceContext(msg.metadata);
    const trace: RouteTrace = {
      sessionId: session.id,
      traceId,
      requestId,
      command,
      phase: "route_unified",
    };

    this.tracer.recv("bridge", msg.type, msg, trace);

    // Capture previous team state for event diffing
    const prevTeam = this.getState(session).team;

    // Apply state reduction (pure function — no side effects, includes team state)
    this.setState(session, reduceState(this.getState(session), msg, session.teamCorrelationBuffer));

    // Emit team events by diffing previous and new team state
    this.emitTeamEvents(session, prevTeam);

    switch (msg.type) {
      case "session_init":
        this.handleSessionInit(session, msg, trace);
        break;
      case "status_change":
        this.handleStatusChange(session, msg, trace);
        break;
      case "assistant":
        this.handleAssistant(session, msg, trace);
        break;
      case "result":
        this.handleResult(session, msg, trace);
        break;
      case "stream_event":
        this.handleStreamEvent(session, msg, trace);
        break;
      case "permission_request":
        this.handlePermissionRequest(session, msg, trace);
        break;
      case "control_response":
        this.capabilitiesPolicy.handleControlResponse(session, msg);
        break;
      case "tool_progress":
        this.handleToolProgress(session, msg, trace);
        break;
      case "tool_use_summary":
        this.handleToolUseSummary(session, msg, trace);
        break;
      case "auth_status":
        this.handleAuthStatus(session, msg, trace);
        break;
      case "configuration_change":
        this.handleConfigurationChange(session, msg, trace);
        break;
      case "session_lifecycle":
        this.handleSessionLifecycle(session, msg, trace);
        break;
      default:
        this.tracer.recv("bridge", `unhandled:${msg.type}`, msg, trace);
        break;
    }
  }

  // ── Team event emission ──────────────────────────────────────────────────

  private emitTeamEvents(session: Session, prevTeam: TeamState | undefined): void {
    const currentTeam = this.getState(session).team;

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
      this.emitEvent(event.type, event.payload as BridgeEventMap[typeof event.type]);
    }
  }

  // ── Individual handlers ──────────────────────────────────────────────────

  private handleSessionInit(session: Session, msg: UnifiedMessage, trace: RouteTrace): void {
    const m = msg.metadata;

    // Store backend session ID for resume
    if (m.session_id) {
      this.setBackendSessionId(session, m.session_id as string);
      this.emitEvent("backend:session_id", {
        sessionId: session.id,
        backendSessionId: m.session_id as string,
      });
    }

    // Resolve git info (unconditional: CLI is authoritative, cwd may differ from seed)
    this.gitTracker.resetAttempt(session.id);
    if (this.getState(session).cwd && this.gitResolver) {
      const gitInfo = this.gitResolver.resolve(this.getState(session).cwd);
      if (gitInfo) this.setState(session, applyGitInfo(this.getState(session), gitInfo));
    }

    // Store auth methods if the backend advertises them
    if (Array.isArray(m.authMethods)) {
      this.setState(session, {
        ...this.getState(session),
        authMethods: m.authMethods as SessionState["authMethods"],
      });
    }

    // Populate registry from init data (per-session)
    this.clearDynamicSlashRegistry(session);
    const state = this.getState(session);
    if (state.slash_commands.length > 0) {
      this.registerCLICommands(
        session,
        state.slash_commands.map((name: string) => ({ name, description: "" })),
      );
    }
    if (state.skills.length > 0) {
      this.registerSkillCommands(session, state.skills);
    }

    const initMsg = {
      type: "session_init" as const,
      session: this.getState(session),
      protocol_version: CONSUMER_PROTOCOL_VERSION,
    };
    this.traceT4("handleSessionInit", session, msg, initMsg, trace);
    this.broadcaster.broadcast(session, initMsg);
    this.persistSession(session);

    // If the adapter already provided capabilities in the init message (e.g. Codex),
    // apply them directly instead of sending a separate control_request (Claude-only).
    if (m.capabilities && typeof m.capabilities === "object") {
      const caps = m.capabilities as {
        commands?: InitializeCommand[];
        models?: InitializeModel[];
        account?: InitializeAccount;
      };
      this.capabilitiesPolicy.applyCapabilities(
        session,
        Array.isArray(caps.commands) ? caps.commands : [],
        Array.isArray(caps.models) ? caps.models : [],
        caps.account ?? null,
      );
    } else {
      this.capabilitiesPolicy.sendInitializeRequest(session);
    }
  }

  private handleStatusChange(session: Session, msg: UnifiedMessage, trace: RouteTrace): void {
    const status = msg.metadata.status as string | null | undefined;
    const nextStatus = (status ?? null) as "compacting" | "idle" | "running" | null;
    this.setLastStatus(session, nextStatus);
    const { status: _s, ...rest } = msg.metadata;
    const filtered = Object.fromEntries(Object.entries(rest).filter(([, v]) => v != null));
    const statusMsg = {
      type: "status_change" as const,
      status: this.getLastStatus(session),
      ...(Object.keys(filtered).length > 0 && { metadata: filtered }),
    };
    this.traceT4("handleStatusChange", session, msg, statusMsg, trace);
    this.broadcaster.broadcast(session, statusMsg);

    // Broadcast permissionMode change so frontend can confirm the update
    if (msg.metadata.permissionMode !== undefined && msg.metadata.permissionMode !== null) {
      this.broadcaster.broadcast(session, {
        type: "session_update",
        session: { permissionMode: this.getState(session).permissionMode } as Partial<SessionState>,
      });
    }

    // Auto-send queued message when transitioning to idle
    if (status === "idle") {
      this.queueHandler.autoSendQueuedMessage(session);
    }
  }

  private handleAssistant(session: Session, msg: UnifiedMessage, trace: RouteTrace): void {
    const consumerMsg = mapAssistantMessage(msg);
    if (consumerMsg.type !== "assistant") return;
    this.traceT4("mapAssistantMessage", session, msg, consumerMsg, trace);

    const existingIndex = this.findAssistantMessageIndexById(session, consumerMsg.message.id);
    if (existingIndex >= 0) {
      const existing = this.getMessageHistory(session)[existingIndex];
      if (
        existing.type === "assistant" &&
        this.assistantMessagesEquivalent(existing, consumerMsg)
      ) {
        return;
      }
      this.replaceMessageHistoryAt(session, existingIndex, consumerMsg);
      this.broadcaster.broadcast(session, consumerMsg);
      this.persistSession(session);
      return;
    }

    this.appendMessageHistory(session, consumerMsg);
    this.broadcaster.broadcast(session, consumerMsg);
    this.persistSession(session);
  }

  private handleResult(session: Session, msg: UnifiedMessage, trace: RouteTrace): void {
    const consumerMsg = mapResultMessage(msg);
    this.traceT4("mapResultMessage", session, msg, consumerMsg, trace);
    this.appendMessageHistory(session, consumerMsg);
    this.broadcaster.broadcast(session, consumerMsg);
    this.persistSession(session);

    // Mark session idle — the CLI only sends status_change for "compacting" | null,
    // so the bridge must infer "idle" from result messages (mirrors frontend logic).
    this.setLastStatus(session, "idle");
    this.queueHandler.autoSendQueuedMessage(session);

    // Trigger auto-naming after first turn
    const m = msg.metadata;
    const numTurns = (m.num_turns as number) ?? 0;
    const isError = (m.is_error as boolean) ?? false;
    if (numTurns === 1 && !isError) {
      const firstUserMsg = this.getMessageHistory(session).find(
        (entry) => entry.type === "user_message",
      );
      if (firstUserMsg && firstUserMsg.type === "user_message") {
        this.emitEvent("session:first_turn_completed", {
          sessionId: session.id,
          firstUserMessage: firstUserMsg.content,
        });
      }
    }

    // Re-resolve git info — the CLI may have committed, switched branches, etc.
    const gitUpdate = this.gitTracker.refreshGitInfo(session);
    if (gitUpdate) {
      this.broadcaster.broadcast(session, {
        type: "session_update",
        session: gitUpdate,
      });
    }
  }

  private handleStreamEvent(session: Session, msg: UnifiedMessage, trace: RouteTrace): void {
    const m = msg.metadata;
    const event = m.event as { type?: string } | undefined;

    // Derive "running" status from message_start (main session only).
    // The CLI only sends status_change for "compacting" | null — it never
    // reports "running", so the bridge must infer it from stream events.
    //
    // This inference is Claude-specific:
    // - OpenCode: emits "busy" via session.status → handled by handleStatusChange()
    // - ACP/Gemini: no explicit "running" — activity implied by stream_event/tool_progress
    // Generalizing (e.g. treating first stream_event as "running") was rejected
    // due to false positives from sub-agent streams. See ISSUE 3 in
    // docs/unified-message-protocol.md.
    if (event?.type === "message_start" && !m.parent_tool_use_id) {
      this.setLastStatus(session, "running");
      this.broadcaster.broadcast(session, {
        type: "status_change",
        status: this.getLastStatus(session),
      });
    }

    const streamConsumerMsg = mapStreamEvent(msg);
    this.traceT4("mapStreamEvent", session, msg, streamConsumerMsg, trace);
    this.broadcaster.broadcast(session, streamConsumerMsg);
  }

  private handlePermissionRequest(session: Session, msg: UnifiedMessage, trace: RouteTrace): void {
    const mapped = mapPermissionRequest(msg);
    if (!mapped) return;
    this.traceT4("mapPermissionRequest", session, msg, mapped.consumerPerm, trace);

    const { consumerPerm, cliPerm } = mapped;
    this.storePendingPermission(session, consumerPerm.request_id, cliPerm);

    this.broadcaster.broadcastToParticipants(session, {
      type: "permission_request",
      request: consumerPerm,
    });
    this.emitEvent("permission:requested", {
      sessionId: session.id,
      request: cliPerm,
    });
    this.persistSession(session);
  }

  private handleToolProgress(session: Session, msg: UnifiedMessage, trace: RouteTrace): void {
    const consumerMsg = mapToolProgress(msg);
    this.traceT4("mapToolProgress", session, msg, consumerMsg, trace);
    this.broadcaster.broadcast(session, consumerMsg);
  }

  private handleToolUseSummary(session: Session, msg: UnifiedMessage, trace: RouteTrace): void {
    const consumerMsg = mapToolUseSummary(msg);
    if (consumerMsg.type !== "tool_use_summary") return;
    this.traceT4("mapToolUseSummary", session, msg, consumerMsg, trace);

    const toolUseId = consumerMsg.tool_use_id ?? consumerMsg.tool_use_ids[0];
    if (toolUseId) {
      const existingIndex = this.findToolSummaryIndexByToolUseId(session, toolUseId);
      if (existingIndex >= 0) {
        const existing = this.getMessageHistory(session)[existingIndex];
        if (
          existing.type === "tool_use_summary" &&
          this.toolSummariesEquivalent(existing, consumerMsg)
        ) {
          return;
        }
        this.replaceMessageHistoryAt(session, existingIndex, consumerMsg);
        this.broadcaster.broadcast(session, consumerMsg);
        this.persistSession(session);
        return;
      }
    }

    this.appendMessageHistory(session, consumerMsg);
    this.broadcaster.broadcast(session, consumerMsg);
    this.persistSession(session);
  }

  private handleAuthStatus(session: Session, msg: UnifiedMessage, trace: RouteTrace): void {
    const consumerMsg = mapAuthStatus(msg);
    this.traceT4("mapAuthStatus", session, msg, consumerMsg, trace);
    this.broadcaster.broadcast(session, consumerMsg);
    const m = msg.metadata;
    this.emitEvent("auth_status", {
      sessionId: session.id,
      isAuthenticating: m.isAuthenticating as boolean,
      output: m.output as string[],
      error: m.error as string | undefined,
    });
  }

  private handleConfigurationChange(
    session: Session,
    msg: UnifiedMessage,
    trace: RouteTrace,
  ): void {
    const consumerMsg = mapConfigurationChange(msg);
    this.traceT4("mapConfigurationChange", session, msg, consumerMsg, trace);
    this.broadcaster.broadcast(session, consumerMsg);

    // Also broadcast a session_update so frontend state stays in sync
    const m = msg.metadata;
    const patch: Record<string, unknown> = {};
    if (typeof m.model === "string") patch.model = m.model;
    const modeValue =
      typeof m.mode === "string"
        ? m.mode
        : typeof m.permissionMode === "string"
          ? m.permissionMode
          : undefined;
    if (modeValue !== undefined) patch.permissionMode = modeValue;
    if (Object.keys(patch).length > 0) {
      this.broadcaster.broadcast(session, {
        type: "session_update",
        session: patch as Partial<SessionState>,
      });
      this.persistSession(session);
    }
  }

  private handleSessionLifecycle(session: Session, msg: UnifiedMessage, trace: RouteTrace): void {
    const consumerMsg = mapSessionLifecycle(msg);
    this.traceT4("mapSessionLifecycle", session, msg, consumerMsg, trace);
    this.broadcaster.broadcast(session, consumerMsg);
  }

  // ── Trace helpers ────────────────────────────────────────────────────────

  private traceT4(
    mapperName: string,
    session: Session,
    unifiedMsg: UnifiedMessage,
    consumerMsg: unknown,
    trace: RouteTrace,
  ): void {
    this.tracer.translate(
      mapperName,
      "T4",
      { format: "UnifiedMessage", body: unifiedMsg },
      { format: "ConsumerMessage", body: consumerMsg },
      {
        sessionId: session.id,
        traceId: trace.traceId,
        requestId: trace.requestId,
        command: trace.command,
        phase: "t4",
      },
    );
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private appendMessageHistory(session: Session, message: ConsumerMessage): void {
    const history = this.getMessageHistory(session);
    this.setMessageHistory(session, this.trimMessageHistory([...history, message]));
  }

  private replaceMessageHistoryAt(session: Session, index: number, message: ConsumerMessage): void {
    const history = this.getMessageHistory(session);
    if (index < 0 || index >= history.length) return;
    const next = [...history];
    next[index] = message;
    this.setMessageHistory(session, next);
  }

  private trimMessageHistory(history: Session["messageHistory"]): Session["messageHistory"] {
    if (history.length <= this.maxMessageHistoryLength) return history;
    return history.slice(-this.maxMessageHistoryLength);
  }

  private findAssistantMessageIndexById(session: Session, messageId: string): number {
    const history = this.getMessageHistory(session);
    for (let i = history.length - 1; i >= 0; i--) {
      const item = history[i];
      if (item.type === "assistant" && item.message.id === messageId) {
        return i;
      }
    }
    return -1;
  }

  private assistantMessagesEquivalent(
    a: Extract<ConsumerMessage, { type: "assistant" }>,
    b: Extract<ConsumerMessage, { type: "assistant" }>,
  ): boolean {
    if (a.parent_tool_use_id !== b.parent_tool_use_id) return false;
    if (a.message.id !== b.message.id) return false;
    if (a.message.model !== b.message.model) return false;
    if (a.message.stop_reason !== b.message.stop_reason) return false;
    return JSON.stringify(a.message.content) === JSON.stringify(b.message.content);
  }

  private findToolSummaryIndexByToolUseId(session: Session, toolUseId: string): number {
    const history = this.getMessageHistory(session);
    for (let i = history.length - 1; i >= 0; i--) {
      const item = history[i];
      if (item.type !== "tool_use_summary") continue;
      if (item.tool_use_id === toolUseId || item.tool_use_ids.includes(toolUseId)) {
        return i;
      }
    }
    return -1;
  }

  private toolSummariesEquivalent(
    a: Extract<ConsumerMessage, { type: "tool_use_summary" }>,
    b: Extract<ConsumerMessage, { type: "tool_use_summary" }>,
  ): boolean {
    return (
      a.summary === b.summary &&
      a.status === b.status &&
      a.is_error === b.is_error &&
      JSON.stringify(a.tool_use_ids) === JSON.stringify(b.tool_use_ids) &&
      JSON.stringify(a.output) === JSON.stringify(b.output) &&
      JSON.stringify(a.error) === JSON.stringify(b.error)
    );
  }
}
