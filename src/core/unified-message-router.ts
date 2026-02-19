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
  mapPermissionRequest,
  mapResultMessage,
  mapStreamEvent,
  mapToolProgress,
  mapToolUseSummary,
} from "./consumer-message-mapper.js";
import { applyGitInfo, type GitInfoTracker } from "./git-info-tracker.js";
import type { MessageQueueHandler } from "./message-queue-handler.js";
import type { Session } from "./session-store.js";
import { reduce as reduceState } from "./session-state-reducer.js";
import { diffTeamState } from "./team-event-differ.js";
import type { TeamState } from "./types/team-types.js";
import type { UnifiedMessage } from "./types/unified-message.js";

// ─── Dependency contracts ────────────────────────────────────────────────────

type EmitEvent = (type: string, payload: unknown) => void;
type PersistSession = (session: Session) => void;

export interface UnifiedMessageRouterDeps {
  broadcaster: ConsumerBroadcaster;
  capabilitiesProtocol: CapabilitiesProtocol;
  queueHandler: MessageQueueHandler;
  gitTracker: GitInfoTracker;
  gitResolver: GitInfoResolver | null;
  emitEvent: EmitEvent;
  persistSession: PersistSession;
  maxMessageHistoryLength: number;
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

  constructor(deps: UnifiedMessageRouterDeps) {
    this.broadcaster = deps.broadcaster;
    this.capabilitiesProtocol = deps.capabilitiesProtocol;
    this.queueHandler = deps.queueHandler;
    this.gitTracker = deps.gitTracker;
    this.gitResolver = deps.gitResolver;
    this.emitEvent = deps.emitEvent;
    this.persistSession = deps.persistSession;
    this.maxMessageHistoryLength = deps.maxMessageHistoryLength;
  }

  /** Route a UnifiedMessage through state reduction and the appropriate handler. */
  route(session: Session, msg: UnifiedMessage): void {
    // Capture previous team state for event diffing
    const prevTeam = session.state.team;

    // Apply state reduction (pure function — no side effects, includes team state)
    session.state = reduceState(session.state, msg, session.teamCorrelationBuffer);

    // Emit team events by diffing previous and new team state
    this.emitTeamEvents(session, prevTeam);

    switch (msg.type) {
      case "session_init":
        this.handleSessionInit(session, msg);
        break;
      case "status_change":
        this.handleStatusChange(session, msg);
        break;
      case "assistant":
        this.handleAssistant(session, msg);
        break;
      case "result":
        this.handleResult(session, msg);
        break;
      case "stream_event":
        this.handleStreamEvent(session, msg);
        break;
      case "permission_request":
        this.handlePermissionRequest(session, msg);
        break;
      case "control_response":
        this.capabilitiesProtocol.handleControlResponse(session, msg);
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

  private handleSessionInit(session: Session, msg: UnifiedMessage): void {
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

    this.broadcaster.broadcast(session, {
      type: "session_init",
      session: session.state,
    });
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

  private handleStatusChange(session: Session, msg: UnifiedMessage): void {
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
      this.queueHandler.autoSendQueuedMessage(session);
    }
  }

  private handleAssistant(session: Session, msg: UnifiedMessage): void {
    const consumerMsg = mapAssistantMessage(msg);
    session.messageHistory.push(consumerMsg);
    this.trimMessageHistory(session);
    this.broadcaster.broadcast(session, consumerMsg);
    this.persistSession(session);
  }

  private handleResult(session: Session, msg: UnifiedMessage): void {
    const consumerMsg = mapResultMessage(msg);
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

  private handleStreamEvent(session: Session, msg: UnifiedMessage): void {
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

    this.broadcaster.broadcast(session, mapStreamEvent(msg));
  }

  private handlePermissionRequest(session: Session, msg: UnifiedMessage): void {
    const mapped = mapPermissionRequest(msg);
    if (!mapped) return;

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

  private handleToolProgress(session: Session, msg: UnifiedMessage): void {
    this.broadcaster.broadcast(session, mapToolProgress(msg));
  }

  private handleToolUseSummary(session: Session, msg: UnifiedMessage): void {
    this.broadcaster.broadcast(session, mapToolUseSummary(msg));
  }

  private handleAuthStatus(session: Session, msg: UnifiedMessage): void {
    const consumerMsg = mapAuthStatus(msg);
    this.broadcaster.broadcast(session, consumerMsg);
    const m = msg.metadata;
    this.emitEvent("auth_status", {
      sessionId: session.id,
      isAuthenticating: m.isAuthenticating as boolean,
      output: m.output as string[],
      error: m.error as string | undefined,
    });
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private trimMessageHistory(session: Session): void {
    if (session.messageHistory.length > this.maxMessageHistoryLength) {
      session.messageHistory = session.messageHistory.slice(-this.maxMessageHistoryLength);
    }
  }
}
