import { afterEach, describe, expect, it, vi } from "vitest";
import { DomainEventBus } from "./domain-event-bus.js";
import { ReconnectPolicy } from "./reconnect-policy.js";

describe("ReconnectPolicy", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("relaunches stale starting sessions after grace period", async () => {
    vi.useFakeTimers();
    const domainEvents = new DomainEventBus();
    const relaunch = vi.fn(async () => true);
    const starting = [{ sessionId: "s1", state: "starting", cwd: "/tmp", createdAt: 1 }] as any[];
    const launcher = {
      getStartingSessions: vi.fn(() => starting),
      relaunch,
    } as any;
    const bridge = {
      broadcastWatchdogState: vi.fn(),
      applyPolicyCommand: vi.fn(),
    } as any;
    const logger = { info: vi.fn(), warn: vi.fn() } as any;

    const policy = new ReconnectPolicy({
      launcher,
      bridge,
      logger,
      reconnectGracePeriodMs: 5000,
      domainEvents,
    });

    policy.start();
    await vi.advanceTimersByTimeAsync(5000);
    await Promise.resolve();

    expect(bridge.applyPolicyCommand).toHaveBeenCalledWith("s1", { type: "reconnect_timeout" });
    expect(relaunch).toHaveBeenCalledWith("s1");
  });
});
