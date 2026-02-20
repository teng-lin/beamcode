import type { AggregatedError } from "../interfaces/metrics.js";
import { RingBuffer } from "../utils/ring-buffer.js";

export type { AggregatedError };

/**
 * Collects errors in a fixed-capacity ring buffer for observability.
 * Provides recent errors and severity-bucketed counts.
 */
export class ErrorAggregator {
  private buffer: RingBuffer<AggregatedError>;
  private counts = { warning: 0, error: 0, critical: 0 };

  constructor(options?: { maxErrors?: number }) {
    this.buffer = new RingBuffer(options?.maxErrors ?? 100);
  }

  record(error: AggregatedError): void {
    this.buffer.push(error);
    this.counts[error.severity]++;
  }

  /** Return recent errors, newest first. */
  getRecentErrors(limit?: number): AggregatedError[] {
    const all = this.buffer.toArray().reverse(); // newest first
    return limit != null ? all.slice(0, limit) : all;
  }

  getCounts(): { warning: number; error: number; critical: number; total: number } {
    return {
      ...this.counts,
      total: this.counts.warning + this.counts.error + this.counts.critical,
    };
  }

  reset(): void {
    this.buffer.clear();
    this.counts = { warning: 0, error: 0, critical: 0 };
  }
}
