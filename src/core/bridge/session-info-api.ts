import type { SessionStorage } from "../../interfaces/storage.js";
import type { SessionSnapshot, SessionState } from "../../types/session-state.js";
import type { Session, SessionRepository } from "../session-repository.js";
import type { RuntimeManager } from "./runtime-manager.js";

export interface SessionInfoApiOptions {
  store: SessionRepository;
  runtimeManager: RuntimeManager;
  getOrCreateSession: (sessionId: string) => Session;
}

export class SessionInfoApi {
  private readonly store: SessionRepository;
  private readonly runtimeManager: RuntimeManager;
  private readonly getOrCreateSession: (sessionId: string) => Session;

  constructor(options: SessionInfoApiOptions) {
    this.store = options.store;
    this.runtimeManager = options.runtimeManager;
    this.getOrCreateSession = options.getOrCreateSession;
  }

  setAdapterName(sessionId: string, name: string): void {
    const session = this.getOrCreateSession(sessionId);
    this.runtime(session).setAdapterName(name);
  }

  seedSessionState(sessionId: string, params: { cwd?: string; model?: string }): void {
    const session = this.getOrCreateSession(sessionId);
    this.runtime(session).seedSessionState(params);
  }

  getSession(sessionId: string): SessionSnapshot | undefined {
    const session = this.store.get(sessionId);
    if (!session) return undefined;
    return this.runtime(session).getSessionSnapshot();
  }

  getAllSessions(): SessionState[] {
    return this.store.getAllStates();
  }

  isCliConnected(sessionId: string): boolean {
    const session = this.store.get(sessionId);
    if (!session) return false;
    return this.runtime(session).isBackendConnected();
  }

  getStorage(): SessionStorage | null {
    return this.store.getStorage();
  }

  private runtime(session: Session) {
    return this.runtimeManager.getOrCreate(session);
  }
}
