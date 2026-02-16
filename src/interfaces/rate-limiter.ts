/**
 * Rate limiter interface.
 * Tracks rate limits for a resource (e.g., per-consumer message rate).
 */
export interface RateLimiter {
  /**
   * Check if an action is allowed.
   * Returns true if allowed, false if rate limit exceeded.
   */
  tryConsume(tokens?: number): boolean;

  /**
   * Reset the rate limiter (e.g., when consumer disconnects).
   */
  reset(): void;
}
