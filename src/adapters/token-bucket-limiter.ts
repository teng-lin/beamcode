import type { RateLimiter } from "../interfaces/rate-limiter.js";

/**
 * Token bucket rate limiter.
 * Allows a certain number of tokens per time window.
 * Useful for rate limiting messages, API calls, etc.
 *
 * Example: 100 tokens per 60 seconds = 100 messages per minute
 */
export class TokenBucketLimiter implements RateLimiter {
  private tokens: number;
  private readonly capacity: number;
  private readonly refillRate: number; // tokens per millisecond
  private lastRefillTime: number;

  /**
   * Create a token bucket rate limiter.
   * @param capacity - Maximum tokens in the bucket
   * @param refillIntervalMs - Time interval for refilling
   * @param tokensPerInterval - Number of tokens to add per interval
   */
  constructor(capacity: number, refillIntervalMs: number, tokensPerInterval: number) {
    this.capacity = capacity;
    this.tokens = capacity; // Start with full bucket
    this.refillRate = tokensPerInterval / refillIntervalMs; // tokens per ms
    this.lastRefillTime = Date.now();
  }

  /**
   * Try to consume a token. Refills bucket first.
   */
  tryConsume(tokensNeeded = 1): boolean {
    this.refill();
    if (this.tokens >= tokensNeeded) {
      this.tokens -= tokensNeeded;
      return true;
    }
    return false;
  }

  /**
   * Refill tokens based on elapsed time.
   */
  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefillTime;
    const tokensToAdd = elapsed * this.refillRate;

    this.tokens = Math.min(this.capacity, this.tokens + tokensToAdd);
    this.lastRefillTime = now;
  }

  /**
   * Reset the rate limiter to full capacity.
   */
  reset(): void {
    this.tokens = this.capacity;
    this.lastRefillTime = Date.now();
  }

  /**
   * Get current token count (for testing/debugging).
   */
  getTokens(): number {
    this.refill();
    return this.tokens;
  }
}
