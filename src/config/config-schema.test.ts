import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, resolveConfig } from "../types/config.js";

describe("config validation", () => {
  it("accepts valid minimal config", () => {
    const config = resolveConfig({ port: 3456 });
    expect(config.port).toBe(3456);
  });

  it("applies defaults for omitted fields", () => {
    const config = resolveConfig({ port: 8080 });
    expect(config.gitCommandTimeoutMs).toBe(DEFAULT_CONFIG.gitCommandTimeoutMs);
    expect(config.maxConcurrentSessions).toBe(DEFAULT_CONFIG.maxConcurrentSessions);
  });

  it("rejects negative port", () => {
    expect(() => resolveConfig({ port: -1 })).toThrow("Invalid configuration");
  });

  it("rejects port above 65535", () => {
    expect(() => resolveConfig({ port: 70000 })).toThrow("Invalid configuration");
  });

  it("rejects non-integer port", () => {
    expect(() => resolveConfig({ port: 3456.5 })).toThrow("Invalid configuration");
  });

  it("rejects negative timeout", () => {
    expect(() => resolveConfig({ port: 3456, gitCommandTimeoutMs: -100 })).toThrow(
      "Invalid configuration",
    );
  });

  it("rejects zero for positive-required fields", () => {
    expect(() => resolveConfig({ port: 3456, killGracePeriodMs: 0 })).toThrow(
      "Invalid configuration",
    );
  });

  it("accepts valid rate limit config", () => {
    const config = resolveConfig({
      port: 3456,
      consumerMessageRateLimit: { tokensPerSecond: 10, burstSize: 5 },
    });
    expect(config.consumerMessageRateLimit.tokensPerSecond).toBe(10);
  });

  it("rejects invalid rate limit (zero burst)", () => {
    expect(() =>
      resolveConfig({
        port: 3456,
        consumerMessageRateLimit: { tokensPerSecond: 10, burstSize: 0 },
      }),
    ).toThrow("Invalid configuration");
  });

  it("accepts valid circuit breaker config", () => {
    const config = resolveConfig({
      port: 3456,
      cliRestartCircuitBreaker: {
        failureThreshold: 3,
        windowMs: 30000,
        recoveryTimeMs: 15000,
        successThreshold: 1,
      },
    });
    expect(config.cliRestartCircuitBreaker.failureThreshold).toBe(3);
  });

  it("preserves security deny list when provided", () => {
    const config = resolveConfig({ port: 3456, envDenyList: ["SECRET_KEY"] });
    expect(config.envDenyList).toEqual(["SECRET_KEY"]);
  });

  it("restores default deny list when empty array provided", () => {
    const config = resolveConfig({ port: 3456, envDenyList: [] });
    expect(config.envDenyList).toEqual(DEFAULT_CONFIG.envDenyList);
  });

  it("accepts function for cliWebSocketUrlTemplate", () => {
    const config = resolveConfig({
      port: 3456,
      cliWebSocketUrlTemplate: (id: string) => `ws://localhost/${id}`,
    });
    expect(config.cliWebSocketUrlTemplate!("test")).toBe("ws://localhost/test");
  });

  it("accepts zero for idleSessionTimeoutMs (disabled)", () => {
    const config = resolveConfig({ port: 3456, idleSessionTimeoutMs: 0 });
    expect(config.idleSessionTimeoutMs).toBe(0);
  });
});
