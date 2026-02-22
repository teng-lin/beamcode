/**
 * Domain event maps for the bridge, launcher, and session coordinator.
 *
 * Events flow through {@link TypedEventEmitter} and are consumed by the
 * coordinator, metrics, and consumer-plane layers.
 * @module
 */

import type { TeamMember, TeamTask } from "../core/types/team-types.js";
import type { UnifiedMessage } from "../core/types/unified-message.js";
import type { ConsumerIdentity, ConsumerRole } from "./auth.js";
import type {
  InitializeAccount,
  InitializeCommand,
  InitializeModel,
  PermissionRequest,
} from "./cli-messages.js";
import type { ConsumerMessage } from "./consumer-messages.js";
import type { InboundMessage } from "./inbound-messages.js";

/** Events emitted by {@link SessionBridge} — backend, consumer, message, and lifecycle events. */
export interface BridgeEventMap {
  // ── Backend events (adapter-agnostic) ──
  "backend:connected": { sessionId: string };
  "backend:disconnected": { sessionId: string; code: number; reason: string };
  "backend:session_id": { sessionId: string; backendSessionId: string };
  "backend:relaunch_needed": { sessionId: string };
  "backend:message": { sessionId: string; message: UnifiedMessage };

  // ── Consumer events ──
  "consumer:connected": { sessionId: string; consumerCount: number; identity?: ConsumerIdentity };
  "consumer:disconnected": {
    sessionId: string;
    consumerCount: number;
    identity?: ConsumerIdentity;
  };
  "consumer:authenticated": {
    sessionId: string;
    userId: string;
    displayName: string;
    role: ConsumerRole;
  };
  "consumer:auth_failed": { sessionId: string; reason: string };

  // ── Message events ──
  "message:outbound": { sessionId: string; message: ConsumerMessage };
  "message:inbound": { sessionId: string; message: InboundMessage };

  // ── Permission events ──
  "permission:requested": { sessionId: string; request: PermissionRequest };
  "permission:resolved": {
    sessionId: string;
    requestId: string;
    behavior: "allow" | "deny";
  };

  // ── Session lifecycle events ──
  "session:first_turn_completed": {
    sessionId: string;
    firstUserMessage: string;
  };
  "session:closed": { sessionId: string };

  // ── Slash command events ──
  "slash_command:executed": {
    sessionId: string;
    command: string;
    source: "emulated" | "cli";
    durationMs: number;
  };
  "slash_command:failed": { sessionId: string; command: string; error: string };

  // ── Capabilities events ──
  "capabilities:ready": {
    sessionId: string;
    commands: InitializeCommand[];
    models: InitializeModel[];
    account: InitializeAccount | null;
  };
  "capabilities:timeout": { sessionId: string };

  // ── Team events ──
  "team:created": { sessionId: string; teamName: string };
  "team:deleted": { sessionId: string; teamName: string };
  "team:member:joined": { sessionId: string; member: TeamMember };
  "team:member:idle": { sessionId: string; member: TeamMember };
  "team:member:shutdown": { sessionId: string; member: TeamMember };
  "team:task:created": { sessionId: string; task: TeamTask };
  "team:task:claimed": { sessionId: string; task: TeamTask };
  "team:task:completed": { sessionId: string; task: TeamTask };

  // ── Auth & error events ──
  auth_status: {
    sessionId: string;
    isAuthenticating: boolean;
    output: string[];
    error?: string;
  };
  error: { source: string; error: Error; sessionId?: string };
}

/** Events emitted by the CLI launcher — process lifecycle and output. */
export interface LauncherEventMap {
  "process:spawned": { sessionId: string; pid: number };
  "process:exited": {
    sessionId: string;
    exitCode: number | null;
    uptimeMs: number;
    circuitBreaker?: {
      state: string;
      failureCount: number;
      recoveryTimeRemainingMs: number;
    };
  };
  "process:connected": { sessionId: string };
  "process:resume_failed": { sessionId: string };
  "process:stdout": { sessionId: string; data: string };
  "process:stderr": { sessionId: string; data: string };
  error: { source: string; error: Error; sessionId?: string };
}

/** Combined event map for the top-level SessionCoordinator. */
export type SessionCoordinatorEventMap = BridgeEventMap & LauncherEventMap;
