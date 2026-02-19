import type { IdleSessionReaper as IIdleSessionReaper } from "./interfaces/session-manager-coordination.js";
import type { IdleSessionReaperDeps } from "./interfaces/session-manager-coordination.js";

export class IdleSessionReaper implements IIdleSessionReaper {
  private idleReaperTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private deps: IdleSessionReaperDeps) {}

  start(): void {
    if (!this.deps.idleSessionTimeoutMs || this.deps.idleSessionTimeoutMs <= 0) {
      return;
    }

    const checkInterval = Math.max(1000, this.deps.idleSessionTimeoutMs / 10);

    const check = () => {
      const now = Date.now();
      const allSessions = this.deps.bridge.getAllSessions();

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
          void this.deps.bridge.closeSession(sessionId);
        }
      }

      this.idleReaperTimer = setTimeout(check, checkInterval);
    };

    this.idleReaperTimer = setTimeout(check, checkInterval);
  }

  stop(): void {
    if (!this.idleReaperTimer) return;
    clearTimeout(this.idleReaperTimer);
    this.idleReaperTimer = null;
  }
}
