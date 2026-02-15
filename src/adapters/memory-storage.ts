import type { LauncherStateStorage, SessionStorage } from "../interfaces/storage.js";
import type { PersistedSession } from "../types/session-state.js";

/**
 * In-memory session storage for testing and ephemeral use.
 * No debouncing — all writes are immediate.
 */
export class MemoryStorage implements SessionStorage, LauncherStateStorage {
  private sessions = new Map<string, PersistedSession>();
  private launcherState: unknown = null;

  save(session: PersistedSession): void {
    // No debounce — immediate in-memory write
    this.saveSync(session);
  }

  saveSync(session: PersistedSession): void {
    // Deep clone to prevent mutation from affecting stored state
    this.sessions.set(session.id, JSON.parse(JSON.stringify(session)));
  }

  load(sessionId: string): PersistedSession | null {
    const session = this.sessions.get(sessionId);
    return session ? JSON.parse(JSON.stringify(session)) : null;
  }

  loadAll(): PersistedSession[] {
    return Array.from(this.sessions.values()).map((s) => JSON.parse(JSON.stringify(s)));
  }

  remove(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  setArchived(sessionId: string, archived: boolean): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.archived = archived;
    return true;
  }

  saveLauncherState(data: unknown): void {
    this.launcherState = JSON.parse(JSON.stringify(data));
  }

  loadLauncherState<T>(): T | null {
    return this.launcherState ? (JSON.parse(JSON.stringify(this.launcherState)) as T) : null;
  }

  /** For testing: get the number of stored sessions. */
  get size(): number {
    return this.sessions.size;
  }

  /** For testing: clear all stored data. */
  clear(): void {
    this.sessions.clear();
    this.launcherState = null;
  }
}
