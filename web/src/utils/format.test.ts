import { afterEach, describe, expect, it, vi } from "vitest";
import { cwdBasename, formatCost, formatDuration, formatElapsed, formatTokens } from "./format";

describe("formatTokens", () => {
  it("returns raw number below 1k", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(999)).toBe("999");
  });

  it("formats thousands as k", () => {
    expect(formatTokens(1_000)).toBe("1.0k");
    expect(formatTokens(15_432)).toBe("15.4k");
    expect(formatTokens(999_999)).toBe("1000.0k");
  });

  it("formats millions as M", () => {
    expect(formatTokens(1_000_000)).toBe("1.0M");
    expect(formatTokens(2_500_000)).toBe("2.5M");
  });
});

describe("formatCost", () => {
  it("formats zero cost", () => {
    expect(formatCost(0)).toBe("$0.0000");
  });

  it("shows 4 decimals for tiny costs", () => {
    expect(formatCost(0.001)).toBe("$0.0010");
    expect(formatCost(0.0099)).toBe("$0.0099");
  });

  it("shows 3 decimals for sub-dollar costs", () => {
    expect(formatCost(0.01)).toBe("$0.010");
    expect(formatCost(0.123)).toBe("$0.123");
    expect(formatCost(0.999)).toBe("$0.999");
  });

  it("shows 2 decimals for dollar+ costs", () => {
    expect(formatCost(1)).toBe("$1.00");
    expect(formatCost(12.345)).toBe("$12.35");
  });
});

describe("formatDuration", () => {
  it("shows milliseconds below 1s", () => {
    expect(formatDuration(0)).toBe("0ms");
    expect(formatDuration(500)).toBe("500ms");
    expect(formatDuration(999)).toBe("999ms");
  });

  it("shows seconds below 1min", () => {
    expect(formatDuration(1000)).toBe("1.0s");
    expect(formatDuration(30_000)).toBe("30.0s");
    expect(formatDuration(59_999)).toBe("60.0s");
  });

  it("shows minutes and seconds at 1min+", () => {
    expect(formatDuration(60_000)).toBe("1m 0s");
    expect(formatDuration(90_000)).toBe("1m 30s");
    expect(formatDuration(125_000)).toBe("2m 5s");
  });
});

describe("formatElapsed", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows seconds when under 1 minute", () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    expect(formatElapsed(0)).toBe("10s");
  });

  it("shows 0s when just started", () => {
    vi.useFakeTimers();
    vi.setSystemTime(500);
    expect(formatElapsed(0)).toBe("0s");
  });

  it("shows minutes and seconds at 1min+", () => {
    vi.useFakeTimers();
    vi.setSystemTime(125_000);
    expect(formatElapsed(0)).toBe("2m 5s");
  });
});

describe("cwdBasename", () => {
  it("returns last path segment", () => {
    expect(cwdBasename("/Users/me/project")).toBe("project");
  });

  it("handles trailing slash", () => {
    expect(cwdBasename("/Users/me/project/")).toBe("project");
  });

  it("handles multiple trailing slashes", () => {
    expect(cwdBasename("/Users/me/project///")).toBe("project");
  });

  it("returns full string if no slashes", () => {
    expect(cwdBasename("project")).toBe("project");
  });
});
