import type {
  IdleSessionReaperDeps,
  IdleSessionReaper as IIdleSessionReaper,
} from "./interfaces/session-coordinator-coordination.js";

export type IdlePolicyDeps = IdleSessionReaperDeps;

export class IdlePolicy implements IIdleSessionReaper {
  private idleReaperTimer: ReturnType<typeof setTimeout> | null = null;
  private eventSweepTimer: ReturnType<typeof setTimeout> | null = null;
  private sweepChain: Promise<void> = Promise.resolve();
  private eventCleanups: Array<() => void> = [];
  private checkIntervalMs = 0;
  private running = false;

  constructor(private deps: IdlePolicyDeps) {}

  start(): void {
    if (!this.deps.idleSessionTimeoutMs || this.deps.idleSessionTimeoutMs <= 0) {
      return;
    }
    if (this.running) return;
    this.running = true;
    this.checkIntervalMs = Math.max(1000, this.deps.idleSessionTimeoutMs / 10);
    this.ensureDomainSubscriptions();
    this.schedulePeriodicSweep();
  }

  stop(): void {
    this.running = false;
    if (this.idleReaperTimer) {
      clearTimeout(this.idleReaperTimer);
      this.idleReaperTimer = null;
    }
    if (this.eventSweepTimer) {
      clearTimeout(this.eventSweepTimer);
      this.eventSweepTimer = null;
    }
    this.teardownDomainSubscriptions();
  }

  private ensureDomainSubscriptions(): void {
    if (!this.deps.domainEvents || this.eventCleanups.length > 0) return;

    const requestSweep = () => {
      this.requestEventSweep();
    };

    this.deps.domainEvents.on("consumer:disconnected", requestSweep);
    this.deps.domainEvents.on("backend:disconnected", requestSweep);
    this.deps.domainEvents.on("backend:connected", requestSweep);

    this.eventCleanups.push(() =>
      this.deps.domainEvents?.off("consumer:disconnected", requestSweep),
    );
    this.eventCleanups.push(() =>
      this.deps.domainEvents?.off("backend:disconnected", requestSweep),
    );
    this.eventCleanups.push(() => this.deps.domainEvents?.off("backend:connected", requestSweep));
  }

  private teardownDomainSubscriptions(): void {
    if (this.eventCleanups.length === 0) return;
    for (const cleanup of this.eventCleanups) cleanup();
    this.eventCleanups = [];
  }

  private schedulePeriodicSweep(): void {
    this.idleReaperTimer = setTimeout(() => {
      this.idleReaperTimer = null;
      this.enqueueSweep(true);
    }, this.checkIntervalMs);
  }

  private requestEventSweep(): void {
    if (!this.running || this.eventSweepTimer) return;
    this.eventSweepTimer = setTimeout(() => {
      this.eventSweepTimer = null;
      this.enqueueSweep(false);
    }, 0);
  }

  private enqueueSweep(reschedulePeriodic: boolean): void {
    this.sweepChain = this.sweepChain.then(async () => {
      await this.runSweep();
      if (reschedulePeriodic && this.running && !this.idleReaperTimer) {
        this.schedulePeriodicSweep();
      }
    });
  }

  private async runSweep(): Promise<void> {
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
        this.deps.bridge.applyPolicyCommand?.(sessionId, { type: "idle_reap" });
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
  }
}
