/**
 * SimpleSessionRegistry — lightweight in-memory session registry for forward-connection adapters.
 *
 * Used by adapters (ACP, Gemini, Codex, etc.) that don't spawn local processes
 * but still need to register sessions for the HTTP API and launcher state.
 * Backed by optional LauncherStateStorage for persistence across restarts.
 *
 * @module SessionControl
 */

import type { LauncherStateStorage } from "../interfaces/storage.js";
import type { SessionInfo } from "../types/session-state.js";
import type { RegisterSessionInput, SessionRegistry } from "./interfaces/session-registry.js";

/**
 * Simple in-memory session registry backed by an optional LauncherStateStorage.
 * Used by forward-connection adapters (ACP, Gemini, Codex, etc.) that don't
 * spawn processes but still need to register sessions for the HTTP API.
 */
export class SimpleSessionRegistry implements SessionRegistry {
  private sessions = new Map<string, SessionInfo>();
  private storage: LauncherStateStorage | null;

  constructor(storage?: LauncherStateStorage) {
    this.storage = storage ?? null;
  }

  register(info: RegisterSessionInput): SessionInfo {
    const entry: SessionInfo = {
      sessionId: info.sessionId,
      cwd: info.cwd,
      createdAt: info.createdAt,
      model: info.model,
      adapterName: info.adapterName,
      state: "starting",
    };
    this.sessions.set(info.sessionId, entry);
    this.persistState();
    return entry;
  }

  getSession(sessionId: string): SessionInfo | undefined {
    return this.sessions.get(sessionId);
  }

  listSessions(): SessionInfo[] {
    return Array.from(this.sessions.values());
  }

  getStartingSessions(): SessionInfo[] {
    return Array.from(this.sessions.values()).filter((s) => s.state === "starting");
  }

  markConnected(sessionId: string): void {
    this.updateSession(sessionId, (s) => {
      s.state = "connected";
    });
  }

  setBackendSessionId(sessionId: string, backendSessionId: string): void {
    this.updateSession(sessionId, (s) => {
      s.backendSessionId = backendSessionId;
    });
  }

  setSessionName(sessionId: string, name: string): void {
    this.updateSession(sessionId, (s) => {
      s.name = name;
    });
  }

  setArchived(sessionId: string, archived: boolean): void {
    this.updateSession(sessionId, (s) => {
      s.archived = archived;
    });
  }

  removeSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.persistState();
  }

  /** Restore sessions from persistent storage. Returns count restored. */
  restoreFromStorage(): number {
    if (!this.storage) return 0;
    const data = this.storage.loadLauncherState<SessionInfo[]>();
    if (!data || !Array.isArray(data)) return 0;

    let count = 0;
    for (const info of data) {
      if (!this.sessions.has(info.sessionId)) {
        this.sessions.set(info.sessionId, info);
        count++;
      }
    }
    return count;
  }

  /** Look up a session, apply a mutation, and persist. */
  private updateSession(sessionId: string, mutate: (session: SessionInfo) => void): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    mutate(session);
    this.persistState();
  }

  private persistState(): void {
    if (!this.storage) return;
    this.storage.saveLauncherState(Array.from(this.sessions.values()));
  }
}
