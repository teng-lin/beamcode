import type { CircuitBreaker } from "../interfaces/circuit-breaker.js";

/**
 * Circuit breaker with sliding window failure detection.
 * Transitions between states based on failure rate within a time window.
 *
 * CLOSED: Normal operation, all requests allowed
 * OPEN: Too many failures, requests rejected immediately
 * HALF_OPEN: Testing if system recovered, allow limited requests
 */
export class SlidingWindowBreaker implements CircuitBreaker {
  private state: "closed" | "open" | "half_open" = "closed";
  private failureCount = 0;
  private successCount = 0;
  private lastFailureTime = 0;

  private readonly failureThreshold: number; // Failures to trigger OPEN
  private readonly recoveryTimeMs: number; // Time in OPEN before transitioning to HALF_OPEN
  private readonly successThreshold: number; // Successes in HALF_OPEN to return to CLOSED

  constructor(options: {
    failureThreshold: number; // e.g., 5 failures
    windowMs: number; // e.g., 60000 ms (1 minute) — kept for API compatibility
    recoveryTimeMs: number; // e.g., 30000 ms (30 seconds)
    successThreshold: number; // e.g., 2 successes
  }) {
    this.failureThreshold = options.failureThreshold;
    // Note: windowMs kept for API compatibility but not used in implementation
    // This circuit breaker uses a simpler count-based approach rather than time-windowed
    this.recoveryTimeMs = options.recoveryTimeMs;
    this.successThreshold = options.successThreshold;
  }

  canExecute(): boolean {
    if (this.state === "closed") {
      return true;
    }

    if (this.state === "open") {
      // Check if recovery time has passed
      const timeSinceLastFailure = Date.now() - this.lastFailureTime;
      if (timeSinceLastFailure > this.recoveryTimeMs) {
        // Transition to HALF_OPEN to test if system recovered
        this.state = "half_open";
        this.successCount = 0;
        return true;
      }
      return false; // Still in OPEN, block the request
    }

    if (this.state === "half_open") {
      // Allow requests in HALF_OPEN state
      return true;
    }

    return false;
  }

  recordSuccess(): void {
    if (this.state === "half_open") {
      this.successCount++;
      if (this.successCount >= this.successThreshold) {
        // System recovered, transition back to CLOSED
        this.reset();
      }
    }
  }

  recordFailure(): void {
    this.lastFailureTime = Date.now();

    if (this.state === "closed") {
      this.failureCount++;
      // Check if failures exceed threshold within the window
      if (this.failureCount >= this.failureThreshold) {
        this.state = "open";
      }
    } else if (this.state === "half_open") {
      // Single failure in HALF_OPEN returns to OPEN
      this.state = "open";
    }
  }

  getState(): "closed" | "open" | "half_open" {
    return this.state;
  }

  /**
   * Reset the circuit breaker to CLOSED state.
   */
  private reset(): void {
    this.state = "closed";
    this.failureCount = 0;
    this.successCount = 0;
    this.lastFailureTime = 0;
  }

  /**
   * Force reset to closed state (for testing).
   */
  forceReset(): void {
    this.reset();
  }

  /**
   * Get failure count (for testing).
   */
  getFailureCount(): number {
    return this.failureCount;
  }
}
