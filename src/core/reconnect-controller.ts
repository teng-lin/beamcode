import type { ReconnectController as IReconnectController } from "./interfaces/session-manager-coordination.js";
import type { ReconnectControllerDeps } from "./interfaces/session-manager-coordination.js";

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
      this.deps.bridge.broadcastWatchdogState(info.sessionId, { gracePeriodMs, startedAt: Date.now() });
    }

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      const stale = this.deps.launcher.getStartingSessions();
      for (const info of stale) {
        this.deps.bridge.broadcastWatchdogState(info.sessionId, null);
        if (info.archived) continue;
        this.deps.logger.info(`CLI for session ${info.sessionId} did not reconnect, relaunching...`);
        await this.deps.launcher.relaunch(info.sessionId);
      }
    }, gracePeriodMs);
  }

  stop(): void {
    if (!this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }
}
