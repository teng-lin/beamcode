/**
 * health-check error handling tests.
 *
 * Separated from health-check.test.ts because vi.mock() hoists to module scope
 * and would clobber the real updateHeartbeat used by the integration test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./state-file.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./state-file.js")>();
  return {
    ...actual,
    updateHeartbeat: vi.fn().mockResolvedValue(undefined),
  };
});

import { startHealthCheck } from "./health-check.js";
import { updateHeartbeat } from "./state-file.js";

describe("health-check (mocked state-file)", () => {
  let timer: NodeJS.Timeout | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    (updateHeartbeat as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
  });

  afterEach(() => {
    if (timer) clearInterval(timer);
    vi.useRealTimers();
  });

  it("logs error on every 3rd consecutive failure", async () => {
    const error = new Error("disk full");
    (updateHeartbeat as ReturnType<typeof vi.fn>).mockRejectedValue(error);
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    timer = startHealthCheck("/fake/path", { logger, intervalMs: 100 });

    // Advance through 3 intervals to trigger 3 consecutive failures
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(100);
    }

    // logger.error should have been called once (on the 3rd failure)
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      "Heartbeat failed consecutively",
      expect.objectContaining({
        component: "health-check",
        consecutiveFailures: 3,
      }),
    );
  });

  it("resets consecutive failure counter after success", async () => {
    const error = new Error("temporary");
    (updateHeartbeat as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(error) // fail 1
      .mockRejectedValueOnce(error) // fail 2
      .mockResolvedValueOnce(undefined) // success — resets counter
      .mockRejectedValueOnce(error) // fail 1 again
      .mockRejectedValueOnce(error) // fail 2 again
      .mockRejectedValueOnce(error); // fail 3 — should log

    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    timer = startHealthCheck("/fake/path", { logger, intervalMs: 100 });

    // 2 failures + 1 success + 3 failures = 6 ticks
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(100);
    }

    // Only the second set of 3 failures should trigger the log
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      "Heartbeat failed consecutively",
      expect.objectContaining({ consecutiveFailures: 3 }),
    );
  });

  it("uses default options (noopLogger and DEFAULT_INTERVAL_MS) when none provided", () => {
    // Should not throw when called with no options
    timer = startHealthCheck("/fake/path");
    expect(timer).toBeDefined();

    // Advance one default interval (60s) to verify it fires
    vi.advanceTimersByTime(60_000);
    expect(updateHeartbeat).toHaveBeenCalledTimes(1);
  });
});
