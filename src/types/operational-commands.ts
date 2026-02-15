/**
 * Operational commands for session management.
 * These are privileged commands that allow operational/admin control over sessions.
 * Not intended for consumers using the bridge; only for operators/admins.
 */

/** List all active sessions */
export interface ListSessionsCommand {
  type: "list_sessions";
}

export interface ListSessionsResponse {
  sessionId: string;
  cliConnected: boolean;
  consumerCount: number;
  messageCount: number;
  uptime: number; // milliseconds
  lastActivity: number; // timestamp
}

/** Get detailed stats for a specific session */
export interface GetSessionStatsCommand {
  type: "get_session_stats";
  sessionId: string;
}

export interface GetSessionStatsResponse {
  sessionId: string;
  consumers: number;
  messageCount: number;
  uptime: number;
  lastActivity: number;
  cliConnected: boolean;
  pendingPermissions: number;
  queuedMessages: number;
}

/** Force close a session */
export interface CloseSessionCommand {
  type: "close_session";
  sessionId: string;
  reason?: string; // Optional reason for the close
}

export interface CloseSessionResponse {
  success: boolean;
  sessionId: string;
  message?: string;
}

/** Archive a session (prevent new connections, preserve state) */
export interface ArchiveSessionCommand {
  type: "archive_session";
  sessionId: string;
}

export interface ArchiveSessionResponse {
  success: boolean;
  sessionId: string;
  message?: string;
}

/** Unarchive a previously archived session */
export interface UnarchiveSessionCommand {
  type: "unarchive_session";
  sessionId: string;
}

export interface UnarchiveSessionResponse {
  success: boolean;
  sessionId: string;
  message?: string;
}

/** Get health check summary */
export interface GetHealthCommand {
  type: "get_health";
}

export interface GetHealthResponse {
  status: "ok" | "degraded" | "error";
  activeSessions: number;
  cliConnected: number;
  consumerConnections: number;
  uptime: number; // milliseconds
  timestamp: string;
}

/** Union of all operational commands */
export type OperationalCommand =
  | ListSessionsCommand
  | GetSessionStatsCommand
  | CloseSessionCommand
  | ArchiveSessionCommand
  | UnarchiveSessionCommand
  | GetHealthCommand;

/** Union of all operational responses */
export type OperationalResponse =
  | ListSessionsResponse[]
  | GetSessionStatsResponse
  | CloseSessionResponse
  | ArchiveSessionResponse
  | UnarchiveSessionResponse
  | GetHealthResponse;
