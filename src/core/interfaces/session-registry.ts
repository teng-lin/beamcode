import type { SessionInfo } from "../../types/session-state.js";

/**
 * Read/write registry for session metadata.
 * Every adapter path (inverted or forward) must register sessions here
 * so the HTTP API and frontend can list/query them.
 */
export interface SessionRegistry {
  /** Register a new session entry. Returns the stored SessionInfo. */
  register(info: {
    sessionId: string;
    cwd: string;
    createdAt: number;
    model?: string;
    adapterName?: string;
  }): SessionInfo;

  /** Query session state. */
  getSession(sessionId: string): SessionInfo | undefined;

  /** List all sessions. */
  listSessions(): SessionInfo[];

  /** Get sessions still awaiting their first connection. */
  getStartingSessions(): SessionInfo[];

  /** Mark a session as connected. */
  markConnected(sessionId: string): void;

  /** Store the backend's internal session ID (for resume). */
  setBackendSessionId(sessionId: string, backendSessionId: string): void;

  /** Set display name. */
  setSessionName(sessionId: string, name: string): void;

  /** Set archived flag. */
  setArchived(sessionId: string, archived: boolean): void;

  /** Remove a session from internal state and persist. */
  removeSession(sessionId: string): void;
}
