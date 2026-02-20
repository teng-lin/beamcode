import type { LauncherStateStorage } from "../interfaces/storage.js";
import type { SessionInfo } from "../types/session-state.js";
import type { SessionRegistry } from "./interfaces/session-registry.js";

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

  register(info: {
    sessionId: string;
    cwd: string;
    createdAt: number;
    model?: string;
    adapterName?: string;
  }): SessionInfo {
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
    const session = this.sessions.get(sessionId);
    if (session) {
      session.state = "connected";
      this.persistState();
    }
  }

  setBackendSessionId(sessionId: string, backendSessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.backendSessionId = backendSessionId;
      this.persistState();
    }
  }

  setSessionName(sessionId: string, name: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.name = name;
      this.persistState();
    }
  }

  setArchived(sessionId: string, archived: boolean): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.archived = archived;
      this.persistState();
    }
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

  private persistState(): void {
    if (!this.storage) return;
    this.storage.saveLauncherState(Array.from(this.sessions.values()));
  }
}
