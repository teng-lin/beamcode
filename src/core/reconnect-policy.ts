/**
 * ReconnectPolicy — watchdog for CLI processes that fail to reconnect after restart.
 *
 * On server startup, watches sessions in "starting" state. If a CLI process
 * doesn't reconnect within the grace period, automatically relaunches it.
 * Subscribes to DomainEventBus to clear watchdogs when processes connect.
 *
 * @module SessionControl
 */

import type {
  ReconnectController as IReconnectController,
  ReconnectControllerDeps,
} from "./interfaces/session-coordinator-coordination.js";

export type ReconnectPolicyDeps = ReconnectControllerDeps;

export class ReconnectPolicy implements IReconnectController {
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private watchedSessions = new Set<string>();
  private eventCleanups: Array<() => void> = [];

  constructor(private deps: ReconnectPolicyDeps) {}

  start(): void {
    if (this.reconnectTimer) return;

    const starting = this.deps.launcher.getStartingSessions();
    if (starting.length === 0) return;

    this.ensureDomainSubscriptions();

    const gracePeriodMs = this.deps.reconnectGracePeriodMs;
    this.deps.logger.info(
      `Waiting ${gracePeriodMs / 1000}s for ${starting.length} CLI process(es) to reconnect...`,
    );

    for (const info of starting) {
      this.watchedSessions.add(info.sessionId);
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
    this.clearAllWatchdogs();
    this.teardownDomainSubscriptions();
  }

  private async relaunchStaleSessions(): Promise<void> {
    const stale = this.deps.launcher.getStartingSessions();
    const relaunches = stale.map(async (info) => {
      this.clearWatchdog(info.sessionId);
      this.deps.bridge.applyPolicyCommand?.(info.sessionId, { type: "reconnect_timeout" });
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
    this.teardownDomainSubscriptions();
  }

  private ensureDomainSubscriptions(): void {
    if (!this.deps.domainEvents || this.eventCleanups.length > 0) return;

    const clearOnConnect = ({ payload }: { payload: { sessionId: string } }) => {
      this.clearWatchdog(payload.sessionId);
    };
    const clearOnClose = ({ payload }: { payload: { sessionId: string } }) => {
      this.clearWatchdog(payload.sessionId);
    };

    this.deps.domainEvents.on("process:connected", clearOnConnect);
    this.deps.domainEvents.on("backend:connected", clearOnConnect);
    this.deps.domainEvents.on("session:closed", clearOnClose);

    this.eventCleanups.push(() => this.deps.domainEvents?.off("process:connected", clearOnConnect));
    this.eventCleanups.push(() => this.deps.domainEvents?.off("backend:connected", clearOnConnect));
    this.eventCleanups.push(() => this.deps.domainEvents?.off("session:closed", clearOnClose));
  }

  private teardownDomainSubscriptions(): void {
    if (this.eventCleanups.length === 0) return;
    for (const cleanup of this.eventCleanups) cleanup();
    this.eventCleanups = [];
  }

  private clearWatchdog(sessionId: string): void {
    if (!this.watchedSessions.has(sessionId)) return;
    this.watchedSessions.delete(sessionId);
    this.deps.bridge.broadcastWatchdogState(sessionId, null);
  }

  private clearAllWatchdogs(): void {
    for (const sessionId of this.watchedSessions) {
      this.deps.bridge.broadcastWatchdogState(sessionId, null);
    }
    this.watchedSessions.clear();
  }
}
