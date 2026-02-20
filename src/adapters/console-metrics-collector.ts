import type { Logger } from "../interfaces/logger.js";
import type { ErrorStats, MetricsCollector, MetricsEventType } from "../interfaces/metrics.js";
import type { ErrorAggregator } from "./error-aggregator.js";

/**
 * Console-based metrics collector for observability.
 * Logs key metrics events to help monitor production deployments.
 */
export class ConsoleMetricsCollector implements MetricsCollector {
  private sessionEventCounts = new Map<string, number>();
  private sessionConnections = new Map<string, { backend: number; consumers: number }>();

  constructor(
    private logger: Logger,
    private errorAggregator?: ErrorAggregator,
  ) {}

  recordEvent(event: MetricsEventType): void {
    const sessionId = event.sessionId || "global";

    // Track session stats
    if (!this.sessionEventCounts.has(sessionId)) {
      this.sessionEventCounts.set(sessionId, 0);
    }
    this.sessionEventCounts.set(sessionId, (this.sessionEventCounts.get(sessionId) || 0) + 1);

    // Log specific important events
    switch (event.type) {
      case "session:created":
        this.logger.info("Session created", { component: "metrics", sessionId: event.sessionId });
        this.sessionConnections.set(event.sessionId, { backend: 0, consumers: 0 });
        break;

      case "session:closed":
        this.logger.info("Session closed", {
          component: "metrics",
          sessionId: event.sessionId,
          reason: event.reason,
        });
        this.sessionConnections.delete(event.sessionId);
        this.sessionEventCounts.delete(event.sessionId);
        break;

      case "consumer:connected":
        {
          const conn = this.sessionConnections.get(sessionId) || { backend: 0, consumers: 0 };
          conn.consumers++;
          this.sessionConnections.set(sessionId, conn);
          this.logger.debug?.("Consumer connected", {
            component: "metrics",
            sessionId,
            userId: event.userId,
            total: conn.consumers,
          });
        }
        break;

      case "consumer:disconnected":
        {
          const conn = this.sessionConnections.get(sessionId);
          if (conn) conn.consumers--;
          this.logger.debug?.("Consumer disconnected", {
            component: "metrics",
            sessionId,
            userId: event.userId,
          });
        }
        break;

      case "backend:connected":
        {
          const conn = this.sessionConnections.get(sessionId) || { backend: 0, consumers: 0 };
          conn.backend = 1;
          this.sessionConnections.set(sessionId, conn);
          this.logger.debug?.("Backend connected", { component: "metrics", sessionId });
        }
        break;

      case "backend:disconnected":
        {
          const conn = this.sessionConnections.get(sessionId);
          if (conn) conn.backend = 0;
          this.logger.debug?.("Backend disconnected", { component: "metrics", sessionId });
        }
        break;

      case "message:received":
        this.logger.debug?.("Message received", {
          component: "metrics",
          sessionId,
          source: event.source,
          messageType: event.messageType,
        });
        break;

      case "message:sent":
        this.logger.debug?.("Message sent", {
          component: "metrics",
          sessionId,
          target: event.target,
          recipientCount: event.recipientCount ?? 1,
        });
        break;

      case "message:dropped":
        this.logger.warn("Message dropped", {
          component: "metrics",
          sessionId,
          reason: event.reason,
        });
        break;

      case "auth:failed":
        this.logger.warn("Authentication failed", {
          component: "metrics",
          sessionId,
          reason: event.reason,
        });
        break;

      case "send:failed":
        this.logger.warn("Send failed", {
          component: "metrics",
          sessionId,
          target: event.target,
          reason: event.reason,
        });
        break;

      case "error":
        this.logger.warn("Error recorded", {
          component: "metrics",
          source: event.source,
          sessionId: event.sessionId,
          error: event.error,
          severity: event.severity,
        });
        this.errorAggregator?.record({
          timestamp: event.timestamp,
          source: event.source,
          message: event.error,
          sessionId: event.sessionId,
          severity: event.severity,
        });
        break;

      case "ratelimit:exceeded":
        this.logger.warn("Rate limit exceeded", {
          component: "metrics",
          sessionId,
          source: event.source,
        });
        break;

      case "latency":
        this.logger.debug?.("Latency recorded", {
          component: "metrics",
          sessionId,
          operation: event.operation,
          durationMs: event.durationMs,
        });
        break;

      case "queue:depth":
        if (event.depth > (event.maxCapacity ?? 50) * 0.8) {
          this.logger.warn("Queue depth warning", {
            component: "metrics",
            sessionId,
            queueType: event.queueType,
            depth: event.depth,
            maxCapacity: event.maxCapacity,
          });
        }
        break;
    }
  }

  getStats(options?: { sessionId?: string }): Record<string, unknown> {
    if (options?.sessionId) {
      const sessionId = options.sessionId;
      return {
        sessionId,
        eventCount: this.sessionEventCounts.get(sessionId) || 0,
        connections: this.sessionConnections.get(sessionId) || { backend: 0, consumers: 0 },
      };
    }

    // Return global stats
    const totalSessions = this.sessionConnections.size;
    const totalConsumers = Array.from(this.sessionConnections.values()).reduce(
      (sum, conn) => sum + conn.consumers,
      0,
    );
    const backendConnected = Array.from(this.sessionConnections.values()).filter(
      (conn) => conn.backend > 0,
    ).length;

    return {
      totalSessions,
      backendConnected,
      totalConsumers,
      totalEvents: Array.from(this.sessionEventCounts.values()).reduce((a, b) => a + b, 0),
    };
  }

  getErrorStats(): ErrorStats | undefined {
    if (!this.errorAggregator) return undefined;
    return {
      counts: this.errorAggregator.getCounts(),
      recentErrors: this.errorAggregator.getRecentErrors(),
    };
  }

  reset(): void {
    this.sessionEventCounts.clear();
    this.sessionConnections.clear();
    this.errorAggregator?.reset();
  }
}
