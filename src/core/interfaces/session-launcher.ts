import type { LauncherEventMap } from "../../types/events.js";
import type { LaunchOptions, SessionInfo } from "../../types/session-state.js";
import type { TypedEventEmitter } from "../typed-emitter.js";
import type { SessionRegistry } from "./session-registry.js";

// Re-export for convenience
export type { LauncherEventMap, LaunchOptions };

/**
 * Extended interface for inverted-connection adapters that spawn processes.
 * Only ClaudeLauncher implements this. Forward-connection adapters use
 * SessionRegistry directly (via SimpleSessionRegistry).
 */
export interface SessionLauncher extends SessionRegistry, TypedEventEmitter<LauncherEventMap> {
  /** Create a new session and spawn its process. */
  launch(options?: LaunchOptions): SessionInfo;

  /** Kill and respawn a session's process. */
  relaunch(sessionId: string): Promise<boolean>;

  /** Kill a session's process. */
  kill(sessionId: string): Promise<boolean>;

  /** Kill all active processes. */
  killAll(): Promise<void>;

  /** @deprecated Use setBackendSessionId. */
  setCLISessionId?(sessionId: string, backendSessionId: string): void;

  /** Restore sessions from persistent storage. Returns count restored. */
  restoreFromStorage(): number;
}
