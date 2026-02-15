/**
 * Circuit breaker interface.
 * Implements circuit breaker pattern to fail fast when a system is having issues.
 * Prevents cascading failures by stopping requests after repeated failures.
 *
 * States: CLOSED (normal) → OPEN (failing) → HALF_OPEN (testing) → CLOSED
 */
export interface CircuitBreaker {
  /**
   * Check if the circuit breaker allows an action.
   * Returns true if allowed (CLOSED or HALF_OPEN), false if blocked (OPEN).
   */
  canExecute(): boolean;

  /**
   * Record a successful operation.
   * Resets failure counters and transitions to CLOSED state if in HALF_OPEN.
   */
  recordSuccess(): void;

  /**
   * Record a failed operation.
   * Increments failure counters and may transition to OPEN state.
   */
  recordFailure(): void;

  /**
   * Get the current state of the circuit breaker.
   */
  getState(): "closed" | "open" | "half_open";
}
