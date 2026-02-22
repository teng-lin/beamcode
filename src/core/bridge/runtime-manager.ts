/**
 * RuntimeManager — owns the per-session SessionRuntime map.
 *
 * Extracted from SessionBridge to give runtime lifecycle a single,
 * testable owner. The bridge delegates all runtime creation and
 * lookup through this class.
 *
 * @module SessionControl
 */

import type { LifecycleState } from "../session-lifecycle.js";
import type { Session } from "../session-repository.js";
import type { SessionRuntime } from "../session-runtime.js";

export class RuntimeManager {
  private runtimes = new Map<string, SessionRuntime>();

  constructor(private factory: (session: Session) => SessionRuntime) {}

  /** Return existing runtime or create via the factory. */
  getOrCreate(session: Session): SessionRuntime {
    const existing = this.runtimes.get(session.id);
    if (existing) return existing;
    const created = this.factory(session);
    this.runtimes.set(session.id, created);
    return created;
  }

  /** Retrieve an existing runtime (retrieval-only paths). */
  get(sessionId: string): SessionRuntime | undefined {
    return this.runtimes.get(sessionId);
  }

  has(sessionId: string): boolean {
    return this.runtimes.has(sessionId);
  }

  delete(sessionId: string): boolean {
    return this.runtimes.delete(sessionId);
  }

  clear(): void {
    this.runtimes.clear();
  }

  keys(): IterableIterator<string> {
    return this.runtimes.keys();
  }

  getLifecycleState(sessionId: string): LifecycleState | undefined {
    return this.runtimes.get(sessionId)?.getLifecycleState();
  }

  /** Dispatch a lifecycle signal to the runtime (no-op if session unknown). */
  handleLifecycleSignal(
    sessionId: string,
    signal: "backend:connected" | "backend:disconnected" | "session:closed",
  ): void {
    this.runtimes.get(sessionId)?.handleSignal(signal);
  }
}
