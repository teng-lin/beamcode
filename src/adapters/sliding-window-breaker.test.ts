import { describe, expect, it } from "vitest";
import { SlidingWindowBreaker } from "./sliding-window-breaker.js";

describe("SlidingWindowBreaker", () => {
  const defaultOptions = {
    failureThreshold: 3,
    windowMs: 1000,
    recoveryTimeMs: 100,
    successThreshold: 2,
  };

  // -----------------------------------------------------------------------
  // CLOSED state (normal operation)
  // -----------------------------------------------------------------------

  describe("CLOSED state (normal operation)", () => {
    it("allows execution in CLOSED state", () => {
      const breaker = new SlidingWindowBreaker(defaultOptions);
      expect(breaker.canExecute()).toBe(true);
      expect(breaker.getState()).toBe("closed");
    });

    it("records successful execution without state change", () => {
      const breaker = new SlidingWindowBreaker(defaultOptions);
      breaker.recordSuccess();
      expect(breaker.getState()).toBe("closed");
      expect(breaker.canExecute()).toBe(true);
    });

    it("accumulates failures until threshold", () => {
      const breaker = new SlidingWindowBreaker(defaultOptions);

      // Below threshold - still CLOSED
      breaker.recordFailure();
      expect(breaker.getState()).toBe("closed");
      expect(breaker.canExecute()).toBe(true);

      breaker.recordFailure();
      expect(breaker.getState()).toBe("closed");
      expect(breaker.canExecute()).toBe(true);

      // At threshold - transitions to OPEN
      breaker.recordFailure();
      expect(breaker.getState()).toBe("open");
      expect(breaker.canExecute()).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // OPEN state (failing, blocking requests)
  // -----------------------------------------------------------------------

  describe("OPEN state (failing, blocking requests)", () => {
    it("blocks execution in OPEN state", () => {
      const breaker = new SlidingWindowBreaker(defaultOptions);

      // Trigger OPEN state
      for (let i = 0; i < 3; i++) {
        breaker.recordFailure();
      }

      expect(breaker.getState()).toBe("open");
      expect(breaker.canExecute()).toBe(false);
    });

    it("transitions to HALF_OPEN after recovery time", async () => {
      const breaker = new SlidingWindowBreaker(defaultOptions);

      // Trigger OPEN
      for (let i = 0; i < 3; i++) {
        breaker.recordFailure();
      }
      expect(breaker.getState()).toBe("open");

      // Wait for recovery time
      await new Promise((r) => setTimeout(r, 150));

      // Should transition to HALF_OPEN on next canExecute() call
      expect(breaker.canExecute()).toBe(true);
      expect(breaker.getState()).toBe("half_open");
    });
  });

  // -----------------------------------------------------------------------
  // HALF_OPEN state (testing recovery)
  // -----------------------------------------------------------------------

  describe("HALF_OPEN state (testing recovery)", () => {
    it("allows limited execution in HALF_OPEN state", async () => {
      const breaker = new SlidingWindowBreaker(defaultOptions);

      // Trigger OPEN
      for (let i = 0; i < 3; i++) {
        breaker.recordFailure();
      }

      // Wait for recovery
      await new Promise((r) => setTimeout(r, 150));
      breaker.canExecute(); // Transition to HALF_OPEN

      expect(breaker.getState()).toBe("half_open");
      expect(breaker.canExecute()).toBe(true);
    });

    it("returns to CLOSED after successful executions", async () => {
      const breaker = new SlidingWindowBreaker(defaultOptions);

      // Trigger OPEN
      for (let i = 0; i < 3; i++) {
        breaker.recordFailure();
      }

      // Recover
      await new Promise((r) => setTimeout(r, 150));
      breaker.canExecute(); // HALF_OPEN

      // Record successes
      breaker.recordSuccess();
      expect(breaker.getState()).toBe("half_open");

      breaker.recordSuccess();
      expect(breaker.getState()).toBe("closed"); // Recovered!
      expect(breaker.canExecute()).toBe(true);
    });

    it("returns to OPEN on any failure in HALF_OPEN", async () => {
      const breaker = new SlidingWindowBreaker(defaultOptions);

      // Trigger OPEN
      for (let i = 0; i < 3; i++) {
        breaker.recordFailure();
      }

      // Recover to HALF_OPEN
      await new Promise((r) => setTimeout(r, 150));
      breaker.canExecute();

      // Single failure returns to OPEN
      breaker.recordFailure();
      expect(breaker.getState()).toBe("open");
      expect(breaker.canExecute()).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // State transitions
  // -----------------------------------------------------------------------

  describe("state transitions", () => {
    it("follows full recovery cycle: CLOSED → OPEN → HALF_OPEN → CLOSED", async () => {
      const breaker = new SlidingWindowBreaker(defaultOptions);

      // CLOSED
      expect(breaker.getState()).toBe("closed");
      expect(breaker.canExecute()).toBe(true);

      // CLOSED → OPEN
      for (let i = 0; i < 3; i++) {
        breaker.recordFailure();
      }
      expect(breaker.getState()).toBe("open");
      expect(breaker.canExecute()).toBe(false);

      // OPEN → HALF_OPEN
      await new Promise((r) => setTimeout(r, 150));
      breaker.canExecute();
      expect(breaker.getState()).toBe("half_open");

      // HALF_OPEN → CLOSED
      breaker.recordSuccess();
      breaker.recordSuccess();
      expect(breaker.getState()).toBe("closed");
      expect(breaker.canExecute()).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Failure counting
  // -----------------------------------------------------------------------

  describe("failure counting", () => {
    it("resets failure count on recovery", async () => {
      const breaker = new SlidingWindowBreaker(defaultOptions);

      // Accumulate failures
      breaker.recordFailure();
      breaker.recordFailure();
      expect(breaker.getFailureCount()).toBe(2);

      // Trigger OPEN and recover
      breaker.recordFailure();
      expect(breaker.getState()).toBe("open");

      await new Promise((r) => setTimeout(r, 150));
      breaker.canExecute(); // HALF_OPEN
      breaker.recordSuccess();
      breaker.recordSuccess(); // Back to CLOSED
      expect(breaker.getFailureCount()).toBe(0);
    });

    it("tracks failures accurately before threshold", () => {
      const breaker = new SlidingWindowBreaker({
        failureThreshold: 5,
        windowMs: 1000,
        recoveryTimeMs: 100,
        successThreshold: 2,
      });

      for (let i = 1; i <= 4; i++) {
        breaker.recordFailure();
        expect(breaker.getFailureCount()).toBe(i);
      }
      expect(breaker.getState()).toBe("closed"); // Still below threshold
    });
  });

  // -----------------------------------------------------------------------
  // Force reset
  // -----------------------------------------------------------------------

  describe("force reset", () => {
    it("resets to CLOSED state", async () => {
      const breaker = new SlidingWindowBreaker(defaultOptions);

      // Trigger OPEN
      for (let i = 0; i < 3; i++) {
        breaker.recordFailure();
      }
      expect(breaker.getState()).toBe("open");

      // Force reset
      breaker.forceReset();
      expect(breaker.getState()).toBe("closed");
      expect(breaker.canExecute()).toBe(true);
      expect(breaker.getFailureCount()).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // Configuration variations
  // -----------------------------------------------------------------------

  describe("configuration variations", () => {
    it("respects different failure thresholds", () => {
      const breaker = new SlidingWindowBreaker({
        failureThreshold: 10,
        windowMs: 1000,
        recoveryTimeMs: 100,
        successThreshold: 2,
      });

      for (let i = 0; i < 9; i++) {
        breaker.recordFailure();
        expect(breaker.getState()).toBe("closed");
      }

      breaker.recordFailure();
      expect(breaker.getState()).toBe("open");
    });

    it("respects different success thresholds for recovery", async () => {
      const breaker = new SlidingWindowBreaker({
        failureThreshold: 1,
        windowMs: 1000,
        recoveryTimeMs: 50,
        successThreshold: 5,
      });

      breaker.recordFailure();
      expect(breaker.getState()).toBe("open");

      await new Promise((r) => setTimeout(r, 100));
      breaker.canExecute(); // HALF_OPEN

      for (let i = 0; i < 4; i++) {
        breaker.recordSuccess();
        expect(breaker.getState()).toBe("half_open");
      }

      breaker.recordSuccess();
      expect(breaker.getState()).toBe("closed");
    });
  });
});
