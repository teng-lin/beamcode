import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TokenBucketLimiter } from "./token-bucket-limiter.js";

describe("TokenBucketLimiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

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
    it("refills tokens over time", () => {
      const limiter = new TokenBucketLimiter(10, 100, 10); // 10 tokens per 100ms
      expect(limiter.tryConsume()).toBe(true);
      expect(limiter.tryConsume()).toBe(true); // 8 tokens left

      // Advance 50ms = 5 tokens refilled → 13, capped at 10
      vi.advanceTimersByTime(50);

      expect(limiter.getTokens()).toBe(10);
    });

    it("caps tokens at capacity after refill", () => {
      const limiter = new TokenBucketLimiter(5, 100, 10);

      vi.advanceTimersByTime(50); // 5 more tokens would be added

      // Should still be capped at 5
      expect(limiter.getTokens()).toBe(5);
    });

    it("refills completely after consuming and waiting", () => {
      const limiter = new TokenBucketLimiter(10, 100, 10);
      expect(limiter.tryConsume(8)).toBe(true); // 2 tokens left

      // Advance 150ms = 15 more tokens → 17, capped at 10
      vi.advanceTimersByTime(150);

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
    it("simulates per-second rate limiting (1000 msg/sec)", () => {
      // 1000 messages per second = 1 token per millisecond
      const limiter = new TokenBucketLimiter(1000, 1000, 1000);

      // Consume all tokens (no time passes with fake timers)
      for (let i = 0; i < 1000; i++) {
        expect(limiter.tryConsume()).toBe(true);
      }
      expect(limiter.tryConsume()).toBe(false); // depleted

      // Advance 100ms → 100 new tokens
      vi.advanceTimersByTime(100);
      expect(limiter.getTokens()).toBe(100);
    });

    it("handles burst traffic within burst size", () => {
      const limiter = new TokenBucketLimiter(100, 100_000, 1); // negligible refill during test
      // Start with full burst bucket (100 tokens)
      for (let i = 0; i < 100; i++) {
        expect(limiter.tryConsume()).toBe(true);
      }
      expect(limiter.tryConsume()).toBe(false); // Burst exhausted
    });

    it("prevents sustained high-rate attack after burst", () => {
      const limiter = new TokenBucketLimiter(10, 100, 100); // Refill 100 tokens per 100ms
      // Consume all tokens (burst)
      for (let i = 0; i < 10; i++) {
        expect(limiter.tryConsume()).toBe(true);
      }
      expect(limiter.tryConsume()).toBe(false); // empty

      // Advance 10ms → refill 10 tokens
      vi.advanceTimersByTime(10);
      expect(limiter.getTokens()).toBe(10); // capped at capacity

      // Consume all again
      for (let i = 0; i < 10; i++) {
        expect(limiter.tryConsume()).toBe(true);
      }
      expect(limiter.tryConsume()).toBe(false); // empty again
    });
  });
});
