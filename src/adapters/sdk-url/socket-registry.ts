import type WebSocket from "ws";

interface PendingEntry {
  resolve: (ws: WebSocket) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class SocketRegistry {
  private readonly pending = new Map<string, PendingEntry>();

  /**
   * Register a pending socket for a session.
   * Returns a promise that resolves when deliverSocket() is called with the matching sessionId.
   * Rejects if the timeout expires first.
   */
  register(sessionId: string, timeoutMs = 30_000): Promise<WebSocket> {
    if (this.pending.has(sessionId)) {
      throw new Error(`Session ${sessionId} already has a pending socket registration`);
    }

    return new Promise<WebSocket>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(sessionId);
        reject(
          new Error(`Socket delivery timed out for session ${sessionId} after ${timeoutMs}ms`),
        );
      }, timeoutMs);

      this.pending.set(sessionId, { resolve, reject, timer });
    });
  }

  /**
   * Deliver a WebSocket for a pending session.
   * Returns true if a pending registration was found and resolved, false otherwise.
   */
  deliverSocket(sessionId: string, ws: WebSocket): boolean {
    const entry = this.pending.get(sessionId);
    if (!entry) return false;

    clearTimeout(entry.timer);
    this.pending.delete(sessionId);
    entry.resolve(ws);
    return true;
  }

  /**
   * Cancel a pending socket registration.
   * Rejects the promise with a cancellation error.
   */
  cancel(sessionId: string): void {
    const entry = this.pending.get(sessionId);
    if (!entry) return;

    clearTimeout(entry.timer);
    this.pending.delete(sessionId);
    entry.reject(new Error(`Socket registration cancelled for session ${sessionId}`));
  }

  /** Check if a session has a pending socket registration. */
  hasPending(sessionId: string): boolean {
    return this.pending.has(sessionId);
  }
}
