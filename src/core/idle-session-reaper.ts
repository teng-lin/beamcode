import type {
  IdleSessionReaperDeps,
  IdleSessionReaper as IIdleSessionReaper,
} from "./interfaces/session-manager-coordination.js";

export class IdleSessionReaper implements IIdleSessionReaper {
  private idleReaperTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(private deps: IdleSessionReaperDeps) {}

  start(): void {
    if (!this.deps.idleSessionTimeoutMs || this.deps.idleSessionTimeoutMs <= 0) {
      return;
    }
    if (this.running) return;
    this.running = true;

    const checkInterval = Math.max(1000, this.deps.idleSessionTimeoutMs / 10);

    const check = async () => {
      if (!this.running) return;
      const now = Date.now();
      const allSessions = this.deps.bridge.getAllSessions();
      const closures: Promise<void>[] = [];
      const closureSessionIds: string[] = [];

      for (const sessionState of allSessions) {
        const sessionId = sessionState.session_id;
        const snapshot = this.deps.bridge.getSession(sessionId);

        if (!snapshot) continue;

        if (snapshot.cliConnected || snapshot.consumerCount > 0) {
          continue;
        }

        const lastActivity = snapshot.lastActivity ?? 0;
        const idleMs = now - lastActivity;

        if (idleMs >= this.deps.idleSessionTimeoutMs) {
          this.deps.logger.info(
            `Closing idle session ${sessionId} (idle for ${(idleMs / 1000).toFixed(1)}s)`,
          );
          closures.push(this.deps.bridge.closeSession(sessionId));
          closureSessionIds.push(sessionId);
        }
      }

      const results = await Promise.allSettled(closures);
      for (const [index, result] of results.entries()) {
        if (result.status === "rejected") {
          this.deps.logger.warn(`Failed to close idle session ${closureSessionIds[index]}`, {
            error: result.reason,
          });
        }
      }

      if (!this.running) return;
      this.idleReaperTimer = setTimeout(() => {
        void check();
      }, checkInterval);
    };

    this.idleReaperTimer = setTimeout(() => {
      void check();
    }, checkInterval);
  }

  stop(): void {
    this.running = false;
    if (!this.idleReaperTimer) return;
    clearTimeout(this.idleReaperTimer);
    this.idleReaperTimer = null;
  }
}
