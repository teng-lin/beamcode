import type { ErrorStats, MetricsCollector, MetricsEventType } from "../interfaces/metrics.js";

/**
 * Fans out recordEvent() to N collectors.
 * Delegates getStats/getErrorStats to the first collector that implements them.
 */
export class CompositeMetricsCollector implements MetricsCollector {
  constructor(private readonly collectors: MetricsCollector[]) {}

  recordEvent(event: MetricsEventType): void {
    for (const c of this.collectors) {
      try {
        c.recordEvent(event);
      } catch {
        // Isolate failures: one failing sink must not suppress others
      }
    }
  }

  getStats(options?: { sessionId?: string }): Record<string, unknown> {
    for (const c of this.collectors) {
      if (c.getStats) return c.getStats(options);
    }
    return {};
  }

  getErrorStats(): ErrorStats | undefined {
    for (const c of this.collectors) {
      if (c.getErrorStats) return c.getErrorStats();
    }
    return undefined;
  }

  reset(): void {
    for (const c of this.collectors) {
      c.reset?.();
    }
  }
}
