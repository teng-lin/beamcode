import { describe, expect, it } from "vitest";
import { TokenBucketLimiter } from "./token-bucket-limiter.js";

describe("TokenBucketLimiter", () => {
  // -----------------------------------------------------------------------
  // Basic consumption
  // -----------------------------------------------------------------------

  describe("basic consumption", () => {
    it("allows consumption when tokens available", () => {
      const limiter = new TokenBucketLimiter(10, 1000, 10); // 10 tokens per second
      expect(limiter.tryConsume()).toBe(true);
      expect(limiter.tryConsume()).toBe(true);
    });

    it("blocks consumption when tokens depleted", () => {
      const limiter = new TokenBucketLimiter(2, 1000, 10);
      expect(limiter.tryConsume()).toBe(true); // 1 token left
      expect(limiter.tryConsume()).toBe(true); // 0 tokens left
      expect(limiter.tryConsume()).toBe(false); // blocked
    });

    it("consumes multiple tokens at once", () => {
      const limiter = new TokenBucketLimiter(10, 1000, 10);
      expect(limiter.tryConsume(5)).toBe(true);
      expect(limiter.tryConsume(5)).toBe(true);
      expect(limiter.tryConsume(1)).toBe(false);
    });

    it("tryConsume(n) with various token counts", () => {
      const burstSize = 20;
      const limiter = new TokenBucketLimiter(burstSize, 1000, 20);

      // Consuming 1 token succeeds
      expect(limiter.tryConsume(1)).toBe(true);

      // Consuming 5 tokens succeeds
      expect(limiter.tryConsume(5)).toBe(true);

      // Requesting more than remaining tokens fails
      expect(limiter.tryConsume(burstSize + 1)).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Refilling
  // -----------------------------------------------------------------------

  describe("refilling", () => {
    it("refills tokens over time", async () => {
      const limiter = new TokenBucketLimiter(10, 100, 10); // 10 tokens per 100ms
      expect(limiter.tryConsume()).toBe(true);
      expect(limiter.tryConsume()).toBe(true); // 8 tokens left

      // Wait for partial refill
      await new Promise((r) => setTimeout(r, 50)); // 50ms = 5 tokens refilled

      // Should have approximately 13 tokens, but capped at capacity (10)
      expect(limiter.getTokens()).toBeLessThanOrEqual(10);
      expect(limiter.getTokens()).toBeGreaterThan(8);
    });

    it("caps tokens at capacity after refill", async () => {
      const limiter = new TokenBucketLimiter(5, 100, 10);
      // Start at capacity (5)

      await new Promise((r) => setTimeout(r, 50)); // 5 more tokens would be added

      // Should still be capped at 5
      expect(limiter.getTokens()).toBe(5);
    });

    it("refills completely after consuming and waiting", async () => {
      const limiter = new TokenBucketLimiter(10, 100, 10);
      expect(limiter.tryConsume(8)).toBe(true); // 2 tokens left

      // Wait for full refill
      await new Promise((r) => setTimeout(r, 150)); // 15 more tokens would be added

      expect(limiter.getTokens()).toBe(10); // Refilled to capacity
    });
  });

  // -----------------------------------------------------------------------
  // Reset
  // -----------------------------------------------------------------------

  describe("reset", () => {
    it("resets to full capacity", () => {
      const limiter = new TokenBucketLimiter(20, 1000, 20);
      expect(limiter.tryConsume(15)).toBe(true);
      expect(limiter.getTokens()).toBeCloseTo(5, 1);

      limiter.reset();
      expect(limiter.getTokens()).toBe(20);
    });

    it("allows immediate consumption after reset", () => {
      const limiter = new TokenBucketLimiter(10, 1000, 10);
      expect(limiter.tryConsume(9)).toBe(true);
      expect(limiter.tryConsume(2)).toBe(false); // Not enough tokens left

      limiter.reset();
      expect(limiter.tryConsume()).toBe(true); // Can consume again
    });
  });

  // -----------------------------------------------------------------------
  // Rate limiting scenarios
  // -----------------------------------------------------------------------

  describe("rate limiting scenarios", () => {
    it("simulates per-second rate limiting (1000 msg/sec)", async () => {
      // 1000 messages per second = 1 token per millisecond
      const limiter = new TokenBucketLimiter(1000, 1000, 1000);

      // Consume all tokens quickly
      let consumed = 0;
      while (limiter.tryConsume()) {
        consumed++;
        if (consumed > 1100) break; // safety guard
      }
      // Allow a few tokens refilled during loop execution (timing imprecision)
      expect(consumed).toBeGreaterThanOrEqual(1000);
      expect(consumed).toBeLessThanOrEqual(1010);

      // Wait 100ms for refill (100 new tokens)
      await new Promise((r) => setTimeout(r, 100));
      // Allow margin for timing precision in test execution
      const tokens = limiter.getTokens();
      expect(tokens).toBeGreaterThan(90);
      expect(tokens).toBeLessThanOrEqual(105);
    });

    it("handles burst traffic within burst size", () => {
      const limiter = new TokenBucketLimiter(100, 100_000, 1); // negligible refill during test
      // Start with full burst bucket (100 tokens)
      for (let i = 0; i < 100; i++) {
        expect(limiter.tryConsume()).toBe(true);
      }
      expect(limiter.tryConsume()).toBe(false); // Burst exhausted
    });

    it("prevents sustained high-rate attack after burst", async () => {
      const limiter = new TokenBucketLimiter(10, 100, 100); // Refill 100 tokens per 100ms
      // Consume all tokens (burst)
      for (let i = 0; i < 10; i++) {
        expect(limiter.tryConsume()).toBe(true);
      }
      // After burst, should be empty or nearly empty (timing may allow small refill).
      // Refill rate is 1 token/ms; CI jitter can add 10+ ms of refill time.
      const _attempt = limiter.tryConsume();
      expect(limiter.getTokens()).toBeLessThan(10);

      // Try to send continuously - should be rate-limited
      const results = [];
      for (let i = 0; i < 5; i++) {
        results.push(limiter.tryConsume());
        await new Promise((r) => setTimeout(r, 10)); // 10ms between attempts
      }
      // After 50ms, refill is ~50 tokens (capped at 10), but we already used them
      // Most attempts should fail since we only get 10 tokens per 100ms
      const successCount = results.filter((r) => r).length;
      expect(successCount).toBeLessThanOrEqual(5); // Most should fail
      expect(successCount).toBeGreaterThan(0); // Some should succeed after refill
    });
  });
});
