import type { ConsumerIdentity, ConsumerRole } from "./auth.js";
import type {
  InitializeAccount,
  InitializeCommand,
  InitializeModel,
  PermissionRequest,
} from "./cli-messages.js";
import type { ConsumerMessage } from "./consumer-messages.js";
import type { InboundMessage } from "./inbound-messages.js";

export interface BridgeEventMap {
  "cli:session_id": { sessionId: string; cliSessionId: string };
  "cli:connected": { sessionId: string };
  "cli:disconnected": { sessionId: string };
  "cli:relaunch_needed": { sessionId: string };
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
  "message:outbound": { sessionId: string; message: ConsumerMessage };
  "message:inbound": { sessionId: string; message: InboundMessage };
  "permission:requested": { sessionId: string; request: PermissionRequest };
  "permission:resolved": {
    sessionId: string;
    requestId: string;
    behavior: "allow" | "deny";
  };
  "session:first_turn_completed": {
    sessionId: string;
    firstUserMessage: string;
  };
  "session:closed": { sessionId: string };
  "slash_command:executed": {
    sessionId: string;
    command: string;
    source: "emulated" | "pty";
    durationMs: number;
  };
  "slash_command:failed": { sessionId: string; command: string; error: string };
  "capabilities:ready": {
    sessionId: string;
    commands: InitializeCommand[];
    models: InitializeModel[];
    account: InitializeAccount | null;
  };
  "capabilities:timeout": { sessionId: string };
  auth_status: {
    sessionId: string;
    isAuthenticating: boolean;
    output: string[];
    error?: string;
  };
  error: { source: string; error: Error; sessionId?: string };
}

export interface LauncherEventMap {
  "process:spawned": { sessionId: string; pid: number };
  "process:exited": {
    sessionId: string;
    exitCode: number | null;
    uptimeMs: number;
  };
  "process:connected": { sessionId: string };
  "process:resume_failed": { sessionId: string };
  "process:stdout": { sessionId: string; data: string };
  "process:stderr": { sessionId: string; data: string };
  error: { source: string; error: Error; sessionId?: string };
}

export type SessionManagerEventMap = BridgeEventMap & LauncherEventMap;
