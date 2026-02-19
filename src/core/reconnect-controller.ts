import type {
  ReconnectController as IReconnectController,
  ReconnectControllerDeps,
} from "./interfaces/session-manager-coordination.js";

export class ReconnectController implements IReconnectController {
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private deps: ReconnectControllerDeps) {}

  start(): void {
    const starting = this.deps.launcher.getStartingSessions();
    if (starting.length === 0) return;

    const gracePeriodMs = this.deps.reconnectGracePeriodMs;
    this.deps.logger.info(
      `Waiting ${gracePeriodMs / 1000}s for ${starting.length} CLI process(es) to reconnect...`,
    );

    for (const info of starting) {
      this.deps.bridge.broadcastWatchdogState(info.sessionId, {
        gracePeriodMs,
        startedAt: Date.now(),
      });
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.relaunchStaleSessions();
    }, gracePeriodMs);
  }

  stop(): void {
    if (!this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private async relaunchStaleSessions(): Promise<void> {
    const stale = this.deps.launcher.getStartingSessions();
    const relaunches = stale.map(async (info) => {
      this.deps.bridge.broadcastWatchdogState(info.sessionId, null);
      if (info.archived) return;
      this.deps.logger.info(`CLI for session ${info.sessionId} did not reconnect, relaunching...`);
      await this.deps.launcher.relaunch(info.sessionId);
    });

    const results = await Promise.allSettled(relaunches);
    for (const [index, result] of results.entries()) {
      if (result.status === "rejected") {
        const sessionId = stale[index]?.sessionId ?? "unknown";
        this.deps.logger.warn(`Watchdog relaunch failed for session ${sessionId}`, {
          error: result.reason,
        });
      }
    }
  }
}
