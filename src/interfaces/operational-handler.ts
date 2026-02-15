import type { OperationalCommand, OperationalResponse } from "../types/operational-commands.js";
import type { SessionSnapshot, SessionState } from "../types/session-state.js";
import type { SessionStorage } from "./storage.js";

/**
 * Minimal interface for SessionBridge operations used by SessionOperationalHandler.
 * Avoids tight coupling to SessionBridge implementation while maintaining type safety.
 */
export interface BridgeOperations {
  /**
   * Get all active sessions' states.
   */
  getAllSessions(): SessionState[];

  /**
   * Get detailed snapshot of a specific session.
   */
  getSession(id: string): SessionSnapshot | undefined;

  /**
   * Check if a session has an active CLI connection.
   */
  isCliConnected(id: string): boolean;

  /**
   * Force-close a session and all its connections.
   */
  closeSession(id: string): void;

  /**
   * Optional storage interface for archival operations.
   */
  storage?: SessionStorage;
}

/**
 * Handler for operational commands.
 * Provides privileged operations for session management.
 */
export interface OperationalHandler {
  /**
   * Handle an operational command.
   * Throws if command is invalid or authorization fails.
   */
  handle(command: OperationalCommand): Promise<OperationalResponse>;
}
