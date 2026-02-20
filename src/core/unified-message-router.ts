/**
 * UnifiedMessageRouter — extracted from SessionBridge (Phase 3 / H1).
 *
 * Routes incoming UnifiedMessages to the appropriate handler, applying state
 * reduction and emitting side effects (broadcasts, persistence, events).
 *
 * Exposes a single `route(session, msg)` method.
 */

import type { GitInfoResolver } from "../interfaces/git-resolver.js";
import type {
  InitializeAccount,
  InitializeCommand,
  InitializeModel,
} from "../types/cli-messages.js";
import type { BridgeEventMap } from "../types/events.js";
import type { SessionState } from "../types/session-state.js";
import type { CapabilitiesProtocol } from "./capabilities-protocol.js";
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
import { reduce as reduceState } from "./session-state-reducer.js";
import type { Session } from "./session-store.js";
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
  capabilitiesProtocol: CapabilitiesProtocol;
  queueHandler: MessageQueueHandler;
  gitTracker: GitInfoTracker;
  gitResolver: GitInfoResolver | null;
  emitEvent: EmitEvent;
  persistSession: PersistSession;
  maxMessageHistoryLength: number;
  tracer: MessageTracer;
}

// ─── UnifiedMessageRouter ────────────────────────────────────────────────────

export class UnifiedMessageRouter {
  private broadcaster: ConsumerBroadcaster;
  private capabilitiesProtocol: CapabilitiesProtocol;
  private queueHandler: MessageQueueHandler;
  private gitTracker: GitInfoTracker;
  private gitResolver: GitInfoResolver | null;
  private emitEvent: EmitEvent;
  private persistSession: PersistSession;
  private maxMessageHistoryLength: number;
  private tracer: MessageTracer;

  constructor(deps: UnifiedMessageRouterDeps) {
    this.broadcaster = deps.broadcaster;
    this.capabilitiesProtocol = deps.capabilitiesProtocol;
    this.queueHandler = deps.queueHandler;
    this.gitTracker = deps.gitTracker;
    this.gitResolver = deps.gitResolver;
    this.emitEvent = deps.emitEvent;
    this.persistSession = deps.persistSession;
    this.maxMessageHistoryLength = deps.maxMessageHistoryLength;
    this.tracer = deps.tracer;
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
    const prevTeam = session.state.team;

    // Apply state reduction (pure function — no side effects, includes team state)
    session.state = reduceState(session.state, msg, session.teamCorrelationBuffer);

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
        this.capabilitiesProtocol.handleControlResponse(session, msg);
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
    }
  }

  // ── Team event emission ──────────────────────────────────────────────────

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
      this.emitEvent(event.type, event.payload as BridgeEventMap[typeof event.type]);
    }
  }

  // ── Individual handlers ──────────────────────────────────────────────────

  private handleSessionInit(session: Session, msg: UnifiedMessage, trace: RouteTrace): void {
    const m = msg.metadata;

    // Store backend session ID for resume
    if (m.session_id) {
      session.backendSessionId = m.session_id as string;
      this.emitEvent("backend:session_id", {
        sessionId: session.id,
        backendSessionId: m.session_id as string,
      });
    }

    // Resolve git info (unconditional: CLI is authoritative, cwd may differ from seed)
    this.gitTracker.resetAttempt(session.id);
    if (session.state.cwd && this.gitResolver) {
      const gitInfo = this.gitResolver.resolve(session.state.cwd);
      if (gitInfo) applyGitInfo(session, gitInfo);
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

    const initMsg = { type: "session_init" as const, session: session.state };
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
      this.capabilitiesProtocol.applyCapabilities(
        session,
        Array.isArray(caps.commands) ? caps.commands : [],
        Array.isArray(caps.models) ? caps.models : [],
        caps.account ?? null,
      );
    } else {
      this.capabilitiesProtocol.sendInitializeRequest(session);
    }
  }

  private handleStatusChange(session: Session, msg: UnifiedMessage, trace: RouteTrace): void {
    const status = msg.metadata.status as string | null | undefined;
    session.lastStatus = (status ?? null) as "compacting" | "idle" | "running" | null;
    const statusMsg = { type: "status_change" as const, status: session.lastStatus };
    this.traceT4("handleStatusChange", session, msg, statusMsg, trace);
    this.broadcaster.broadcast(session, statusMsg);

    // Broadcast permissionMode change so frontend can confirm the update
    if (msg.metadata.permissionMode !== undefined && msg.metadata.permissionMode !== null) {
      this.broadcaster.broadcast(session, {
        type: "session_update",
        session: { permissionMode: session.state.permissionMode } as Partial<SessionState>,
      });
    }

    // Auto-send queued message when transitioning to idle
    if (status === "idle") {
      this.queueHandler.autoSendQueuedMessage(session);
    }
  }

  private handleAssistant(session: Session, msg: UnifiedMessage, trace: RouteTrace): void {
    const consumerMsg = mapAssistantMessage(msg);
    this.traceT4("mapAssistantMessage", session, msg, consumerMsg, trace);
    session.messageHistory.push(consumerMsg);
    this.trimMessageHistory(session);
    this.broadcaster.broadcast(session, consumerMsg);
    this.persistSession(session);
  }

  private handleResult(session: Session, msg: UnifiedMessage, trace: RouteTrace): void {
    const consumerMsg = mapResultMessage(msg);
    this.traceT4("mapResultMessage", session, msg, consumerMsg, trace);
    session.messageHistory.push(consumerMsg);
    this.trimMessageHistory(session);
    this.broadcaster.broadcast(session, consumerMsg);
    this.persistSession(session);

    // Mark session idle — the CLI only sends status_change for "compacting" | null,
    // so the bridge must infer "idle" from result messages (mirrors frontend logic).
    session.lastStatus = "idle";
    this.queueHandler.autoSendQueuedMessage(session);

    // Trigger auto-naming after first turn
    const m = msg.metadata;
    const numTurns = (m.num_turns as number) ?? 0;
    const isError = (m.is_error as boolean) ?? false;
    if (numTurns === 1 && !isError) {
      const firstUserMsg = session.messageHistory.find((msg) => msg.type === "user_message");
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
    if (event?.type === "message_start" && !m.parent_tool_use_id) {
      session.lastStatus = "running";
      this.broadcaster.broadcast(session, {
        type: "status_change",
        status: session.lastStatus,
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
    session.pendingPermissions.set(consumerPerm.request_id, cliPerm);

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
    this.traceT4("mapToolUseSummary", session, msg, consumerMsg, trace);
    this.broadcaster.broadcast(session, consumerMsg);
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

  private trimMessageHistory(session: Session): void {
    if (session.messageHistory.length > this.maxMessageHistoryLength) {
      session.messageHistory = session.messageHistory.slice(-this.maxMessageHistoryLength);
    }
  }
}
