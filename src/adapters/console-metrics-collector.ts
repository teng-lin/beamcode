import type { Logger } from "../interfaces/logger.js";
import type { MetricsCollector, MetricsEventType } from "../interfaces/metrics.js";

/**
 * Console-based metrics collector for observability.
 * Logs key metrics events to help monitor production deployments.
 */
export class ConsoleMetricsCollector implements MetricsCollector {
  private sessionEventCounts = new Map<string, number>();
  private sessionConnections = new Map<string, { cli: number; consumers: number }>();

  constructor(private logger: Logger) {}

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
        this.logger.info(`[METRICS] Session created: ${event.sessionId}`);
        this.sessionConnections.set(event.sessionId, { cli: 0, consumers: 0 });
        break;

      case "session:closed":
        this.logger.info(
          `[METRICS] Session closed: ${event.sessionId}${event.reason ? ` (${event.reason})` : ""}`,
        );
        this.sessionConnections.delete(event.sessionId);
        break;

      case "consumer:connected":
        {
          const conn = this.sessionConnections.get(sessionId) || { cli: 0, consumers: 0 };
          conn.consumers++;
          this.sessionConnections.set(sessionId, conn);
          this.logger.debug?.(
            `[METRICS] Consumer connected: session=${sessionId}, userId=${event.userId}, total=${conn.consumers}`,
          );
        }
        break;

      case "consumer:disconnected":
        {
          const conn = this.sessionConnections.get(sessionId);
          if (conn) conn.consumers--;
          this.logger.debug?.(
            `[METRICS] Consumer disconnected: session=${sessionId}, userId=${event.userId}`,
          );
        }
        break;

      case "cli:connected":
        {
          const conn = this.sessionConnections.get(sessionId) || { cli: 0, consumers: 0 };
          conn.cli = 1;
          this.sessionConnections.set(sessionId, conn);
          this.logger.debug?.(`[METRICS] CLI connected: session=${sessionId}`);
        }
        break;

      case "cli:disconnected":
        {
          const conn = this.sessionConnections.get(sessionId);
          if (conn) conn.cli = 0;
          this.logger.debug?.(`[METRICS] CLI disconnected: session=${sessionId}`);
        }
        break;

      case "message:received":
        this.logger.debug?.(
          `[METRICS] Message received: session=${sessionId}, source=${event.source}, type=${event.messageType || "unknown"}`,
        );
        break;

      case "message:sent":
        this.logger.debug?.(
          `[METRICS] Message sent: session=${sessionId}, target=${event.target}, recipients=${event.recipientCount || 1}`,
        );
        break;

      case "message:dropped":
        this.logger.warn(`[METRICS] Message dropped: session=${sessionId}, reason=${event.reason}`);
        break;

      case "auth:failed":
        this.logger.warn(
          `[METRICS] Authentication failed: session=${sessionId}, reason=${event.reason}`,
        );
        break;

      case "send:failed":
        this.logger.warn(
          `[METRICS] Send failed: session=${sessionId}, target=${event.target}, reason=${event.reason}`,
        );
        break;

      case "error":
        this.logger.warn(
          `[METRICS] Error in ${event.source}${event.sessionId ? ` (session=${event.sessionId})` : ""}: ${event.error} [${event.severity}]`,
        );
        break;

      case "ratelimit:exceeded":
        this.logger.warn(
          `[METRICS] Rate limit exceeded: session=${sessionId}, source=${event.source}`,
        );
        break;

      case "latency":
        this.logger.debug?.(
          `[METRICS] Latency: session=${sessionId}, operation=${event.operation}, durationMs=${event.durationMs}`,
        );
        break;

      case "queue:depth":
        if (event.depth > (event.maxCapacity ?? 50) * 0.8) {
          this.logger.warn(
            `[METRICS] Queue depth warning: session=${sessionId}, type=${event.queueType}, depth=${event.depth}/${event.maxCapacity}`,
          );
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
        connections: this.sessionConnections.get(sessionId) || { cli: 0, consumers: 0 },
      };
    }

    // Return global stats
    const totalSessions = this.sessionConnections.size;
    const totalConsumers = Array.from(this.sessionConnections.values()).reduce(
      (sum, conn) => sum + conn.consumers,
      0,
    );
    const cliConnected = Array.from(this.sessionConnections.values()).filter(
      (conn) => conn.cli > 0,
    ).length;

    return {
      totalSessions,
      cliConnected,
      totalConsumers,
      totalEvents: Array.from(this.sessionEventCounts.values()).reduce((a, b) => a + b, 0),
    };
  }

  reset(): void {
    this.sessionEventCounts.clear();
    this.sessionConnections.clear();
  }
}
