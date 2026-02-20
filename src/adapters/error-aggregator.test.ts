import { describe, expect, it } from "vitest";
import type { AggregatedError } from "./error-aggregator.js";
import { ErrorAggregator } from "./error-aggregator.js";

function makeError(overrides: Partial<AggregatedError> = {}): AggregatedError {
  return {
    timestamp: Date.now(),
    source: "bridge",
    message: "test error",
    severity: "error",
    ...overrides,
  };
}

describe("ErrorAggregator", () => {
  it("records and retrieves errors newest-first", () => {
    const agg = new ErrorAggregator();
    agg.record(makeError({ message: "first", timestamp: 1 }));
    agg.record(makeError({ message: "second", timestamp: 2 }));

    const recent = agg.getRecentErrors();
    expect(recent[0].message).toBe("second");
    expect(recent[1].message).toBe("first");
  });

  it("respects capacity limit", () => {
    const agg = new ErrorAggregator({ maxErrors: 3 });
    for (let i = 0; i < 5; i++) {
      agg.record(makeError({ message: `err-${i}` }));
    }

    const recent = agg.getRecentErrors();
    expect(recent).toHaveLength(3);
    expect(recent[0].message).toBe("err-4");
    expect(recent[2].message).toBe("err-2");
  });

  it("limits returned results with limit param", () => {
    const agg = new ErrorAggregator();
    for (let i = 0; i < 10; i++) {
      agg.record(makeError({ message: `err-${i}` }));
    }

    const recent = agg.getRecentErrors(3);
    expect(recent).toHaveLength(3);
    expect(recent[0].message).toBe("err-9");
  });

  it("tracks severity counts", () => {
    const agg = new ErrorAggregator();
    agg.record(makeError({ severity: "warning" }));
    agg.record(makeError({ severity: "warning" }));
    agg.record(makeError({ severity: "error" }));
    agg.record(makeError({ severity: "critical" }));

    expect(agg.getCounts()).toEqual({
      warning: 2,
      error: 1,
      critical: 1,
      total: 4,
    });
  });

  it("counts accumulate beyond buffer capacity", () => {
    const agg = new ErrorAggregator({ maxErrors: 2 });
    for (let i = 0; i < 5; i++) {
      agg.record(makeError({ severity: "error" }));
    }

    // Buffer only holds 2, but counts reflect all 5
    expect(agg.getRecentErrors()).toHaveLength(2);
    expect(agg.getCounts().total).toBe(5);
  });

  it("reset clears buffer and counts", () => {
    const agg = new ErrorAggregator();
    agg.record(makeError());
    agg.reset();

    expect(agg.getRecentErrors()).toHaveLength(0);
    expect(agg.getCounts()).toEqual({ warning: 0, error: 0, critical: 0, total: 0 });
  });
});
