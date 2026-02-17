import type { DevToolSessionState } from "../core/types/core-session-state.js";
import type { TeamState } from "../core/types/team-types.js";
import type { ConsumerRole } from "./auth.js";
import type {
  InitializeAccount,
  InitializeCommand,
  InitializeModel,
  PermissionRequest,
} from "./cli-messages.js";
import type { ConsumerMessage } from "./consumer-messages.js";

export type { CoreSessionState, DevToolSessionState } from "../core/types/core-session-state.js";

export interface InitializeCapabilities {
  commands: InitializeCommand[];
  models: InitializeModel[];
  account: InitializeAccount | null;
  receivedAt: number;
}

/**
 * Full session state for SdkUrl-based backends.
 * Extends DevToolSessionState (which extends CoreSessionState) with
 * SdkUrl-specific fields like model info, tools, MCP servers, etc.
 */
export interface SessionState extends DevToolSessionState {
  model: string;
  cwd: string;
  tools: string[];
  permissionMode: string;
  claude_code_version: string;
  mcp_servers: { name: string; status: string }[];
  agents: string[]; // Deprecated — populated from team.members by the state reducer
  team?: TeamState;
  slash_commands: string[];
  skills: string[];
  last_model_usage?: Record<
    string,
    {
      inputTokens: number;
      outputTokens: number;
      cacheReadInputTokens: number;
      cacheCreationInputTokens: number;
      contextWindow: number;
      costUSD: number;
    }
  >;
  last_duration_ms?: number;
  last_duration_api_ms?: number;
  capabilities?: InitializeCapabilities;
  circuitBreaker?: {
    state: string;
    failureCount: number;
    recoveryTimeRemainingMs: number;
  } | null;
  encryption?: {
    isActive: boolean;
    isPaired: boolean;
  } | null;
  watchdog?: {
    gracePeriodMs: number;
    startedAt: number;
  } | null;
}

/** Explicit alias for the SdkUrl-specific full session state. */
export type SdkUrlSessionState = SessionState;

/** Snapshot of a session's full state (for getSession() return) */
export interface SessionSnapshot {
  id: string;
  state: SessionState;
  cliConnected: boolean;
  consumerCount: number;
  consumers: Array<{ userId: string; displayName: string; role: ConsumerRole }>;
  pendingPermissions: PermissionRequest[];
  messageHistoryLength: number;
  lastActivity: number; // Timestamp of last message or activity
}

/** Session info from the launcher (process-level info) */
export interface SdkSessionInfo {
  sessionId: string;
  pid?: number;
  state: "starting" | "connected" | "running" | "exited";
  exitCode?: number | null;
  model?: string;
  permissionMode?: string;
  cwd: string;
  createdAt: number;
  cliSessionId?: string;
  archived?: boolean;
  isWorktree?: boolean;
  repoRoot?: string;
  branch?: string;
  actualBranch?: string;
  name?: string;
}

export interface LaunchOptions {
  model?: string;
  permissionMode?: string;
  cwd?: string;
  claudeBinary?: string;
  allowedTools?: string[];
  env?: Record<string, string>;
}

/** Shape stored on disk by SessionStorage */
export interface PersistedSession {
  id: string;
  state: SessionState;
  messageHistory: ConsumerMessage[];
  pendingMessages: string[];
  pendingPermissions: [string, PermissionRequest][];
  archived?: boolean;
}
