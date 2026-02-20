import { describe, expect, it, vi } from "vitest";
import type { MetricsCollector, MetricsEventType } from "../interfaces/metrics.js";
import { CompositeMetricsCollector } from "./composite-metrics-collector.js";

function makeEvent(type: string): MetricsEventType {
  return { timestamp: Date.now(), type, sessionId: "s1" } as MetricsEventType;
}

function mockCollector(overrides: Partial<MetricsCollector> = {}): MetricsCollector {
  return {
    recordEvent: vi.fn(),
    ...overrides,
  };
}

describe("CompositeMetricsCollector", () => {
  it("fans out recordEvent to all collectors", () => {
    const a = mockCollector();
    const b = mockCollector();
    const composite = new CompositeMetricsCollector([a, b]);
    const event = makeEvent("session:created");

    composite.recordEvent(event);

    expect(a.recordEvent).toHaveBeenCalledWith(event);
    expect(b.recordEvent).toHaveBeenCalledWith(event);
  });

  it("isolates failures between collectors", () => {
    const a = mockCollector({
      recordEvent: vi.fn(() => {
        throw new Error("boom");
      }),
    });
    const b = mockCollector();
    const composite = new CompositeMetricsCollector([a, b]);
    const event = makeEvent("session:created");

    composite.recordEvent(event);

    expect(b.recordEvent).toHaveBeenCalledWith(event);
  });

  it("delegates getStats to first collector that implements it", () => {
    const a = mockCollector(); // no getStats
    const b = mockCollector({ getStats: () => ({ totalSessions: 5 }) });
    const composite = new CompositeMetricsCollector([a, b]);

    expect(composite.getStats()).toEqual({ totalSessions: 5 });
  });

  it("returns empty object when no collector implements getStats", () => {
    const composite = new CompositeMetricsCollector([mockCollector()]);
    expect(composite.getStats()).toEqual({});
  });

  it("delegates getErrorStats to first collector that implements it", () => {
    const errorStats = {
      counts: { warning: 1, error: 2, critical: 0, total: 3 },
      recentErrors: [],
    };
    const a = mockCollector();
    const b = mockCollector({ getErrorStats: () => errorStats });
    const composite = new CompositeMetricsCollector([a, b]);

    expect(composite.getErrorStats()).toEqual(errorStats);
  });

  it("returns undefined for getErrorStats when none implement it", () => {
    const composite = new CompositeMetricsCollector([mockCollector()]);
    expect(composite.getErrorStats()).toBeUndefined();
  });

  it("calls reset on all collectors", () => {
    const a = mockCollector({ reset: vi.fn() });
    const b = mockCollector({ reset: vi.fn() });
    const composite = new CompositeMetricsCollector([a, b]);

    composite.reset();

    expect(a.reset).toHaveBeenCalled();
    expect(b.reset).toHaveBeenCalled();
  });
});
