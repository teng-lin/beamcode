import type { ConsumerBroadcaster } from "../consumer-broadcaster.js";
import type { Session, SessionRepository } from "../session-repository.js";

export interface SessionBroadcastApiOptions {
  store: SessionRepository;
  broadcaster: ConsumerBroadcaster;
}

export class SessionBroadcastApi {
  private readonly store: SessionRepository;
  private readonly broadcaster: ConsumerBroadcaster;

  constructor(options: SessionBroadcastApiOptions) {
    this.store = options.store;
    this.broadcaster = options.broadcaster;
  }

  broadcastNameUpdate(sessionId: string, name: string): void {
    this.withSessionVoid(sessionId, (session) =>
      this.broadcaster.broadcastNameUpdate(session, name),
    );
  }

  broadcastResumeFailedToConsumers(sessionId: string): void {
    this.withSessionVoid(sessionId, (session) =>
      this.broadcaster.broadcastResumeFailed(session, sessionId),
    );
  }

  broadcastProcessOutput(sessionId: string, stream: "stdout" | "stderr", data: string): void {
    this.withSessionVoid(sessionId, (session) =>
      this.broadcaster.broadcastProcessOutput(session, stream, data),
    );
  }

  broadcastWatchdogState(
    sessionId: string,
    watchdog: { gracePeriodMs: number; startedAt: number } | null,
  ): void {
    this.withSessionVoid(sessionId, (session) =>
      this.broadcaster.broadcastWatchdogState(session, watchdog),
    );
  }

  broadcastCircuitBreakerState(
    sessionId: string,
    circuitBreaker: { state: string; failureCount: number; recoveryTimeRemainingMs: number },
  ): void {
    this.withSessionVoid(sessionId, (session) =>
      this.broadcaster.broadcastCircuitBreakerState(session, circuitBreaker),
    );
  }

  private withSessionVoid(sessionId: string, run: (session: Session) => void): void {
    const session = this.store.get(sessionId);
    if (!session) return;
    run(session);
  }
}
