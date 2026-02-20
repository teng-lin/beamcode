import type { LauncherEventMap } from "../../types/events.js";
import type { LaunchOptions, SessionInfo } from "../../types/session-state.js";
import type { TypedEventEmitter } from "../typed-emitter.js";

// Re-export for convenience
export type { LauncherEventMap, LaunchOptions };

/**
 * Generic interface for session launchers.
 * Each backend (Claude, Codex, Gemini, opencode) provides its own implementation.
 *
 * ClaudeLauncher is the reference implementation. Forward-connection launchers
 * (Codex, Gemini) will implement this interface when they land.
 */
export interface SessionLauncher extends TypedEventEmitter<LauncherEventMap> {
  /** Create a new session and optionally spawn its process. */
  launch(options?: LaunchOptions): SessionInfo;

  /** Kill and respawn a session's process. */
  relaunch(sessionId: string): Promise<boolean>;

  /** Kill a session's process. */
  kill(sessionId: string): Promise<boolean>;

  /** Kill all active processes. */
  killAll(): Promise<void>;

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

  /** @deprecated Use setBackendSessionId. Alias for backward compatibility. */
  setCLISessionId?(sessionId: string, backendSessionId: string): void;

  /** Set display name. */
  setSessionName(sessionId: string, name: string): void;

  /** Set archived flag. */
  setArchived(sessionId: string, archived: boolean): void;

  /** Remove a session from internal state and persist. */
  removeSession(sessionId: string): void;

  /** Restore sessions from persistent storage. Returns count restored. */
  restoreFromStorage(): number;

  /**
   * Register a session created by an external adapter (no process to manage).
   * Transitional: will be removed when per-backend launchers own their session maps.
   */
  registerExternalSession(info: {
    sessionId: string;
    cwd: string;
    createdAt: number;
    model?: string;
    adapterName?: string;
  }): SessionInfo;
}
