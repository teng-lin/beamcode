import type { PersistedSession } from "../types/session-state.js";

/** Persists session data to a backing store. */
export interface SessionStorage {
  /** Debounced write — batches rapid changes. */
  save(session: PersistedSession): void;
  /** Immediate write — use for critical state changes. */
  saveSync(session: PersistedSession): void;
  load(sessionId: string): PersistedSession | null;
  loadAll(): PersistedSession[];
  remove(sessionId: string): void;
  setArchived(sessionId: string, archived: boolean): boolean;
}

/** Separate storage for launcher state, decoupled from session persistence. */
export interface LauncherStateStorage {
  saveLauncherState(data: unknown): void;
  loadLauncherState<T>(): T | null;
}
