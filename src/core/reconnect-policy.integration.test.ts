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

    const controller = new ReconnectPolicy({
      launcher,
      bridge,
      logger,
      reconnectGracePeriodMs: 5000,
      domainEvents,
    });

    controller.start();
    expect(bridge.broadcastWatchdogState).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({ gracePeriodMs: 5000 }),
    );

    await vi.advanceTimersByTimeAsync(5000);
    await Promise.resolve();

    expect(bridge.applyPolicyCommand).toHaveBeenCalledWith("s1", { type: "reconnect_timeout" });
    expect(relaunch).toHaveBeenCalledWith("s1");
    expect(bridge.broadcastWatchdogState).toHaveBeenCalledWith("s1", null);
  });

  it("clears watchdog on process:connected and skips relaunch if no stale sessions remain", async () => {
    vi.useFakeTimers();
    const domainEvents = new DomainEventBus();
    const relaunch = vi.fn(async () => true);
    let starting = [{ sessionId: "s2", state: "starting", cwd: "/tmp", createdAt: 1 }] as any[];
    const launcher = {
      getStartingSessions: vi.fn(() => starting),
      relaunch,
    } as any;
    const bridge = {
      broadcastWatchdogState: vi.fn(),
      applyPolicyCommand: vi.fn(),
    } as any;
    const logger = { info: vi.fn(), warn: vi.fn() } as any;

    const controller = new ReconnectPolicy({
      launcher,
      bridge,
      logger,
      reconnectGracePeriodMs: 5000,
      domainEvents,
    });

    controller.start();
    domainEvents.publishLauncher("process:connected", { sessionId: "s2" });
    starting = [];

    expect(bridge.broadcastWatchdogState).toHaveBeenCalledWith("s2", null);

    await vi.advanceTimersByTimeAsync(5000);
    await Promise.resolve();
    expect(bridge.applyPolicyCommand).not.toHaveBeenCalled();
    expect(relaunch).not.toHaveBeenCalled();
  });

  it("clears watchdogs when stopped", () => {
    vi.useFakeTimers();
    const domainEvents = new DomainEventBus();
    const launcher = {
      getStartingSessions: vi.fn(
        () => [{ sessionId: "s3", state: "starting", cwd: "/tmp", createdAt: 1 }] as any[],
      ),
      relaunch: vi.fn(async () => true),
    } as any;
    const bridge = {
      broadcastWatchdogState: vi.fn(),
      applyPolicyCommand: vi.fn(),
    } as any;
    const logger = { info: vi.fn(), warn: vi.fn() } as any;

    const controller = new ReconnectPolicy({
      launcher,
      bridge,
      logger,
      reconnectGracePeriodMs: 5000,
      domainEvents,
    });

    controller.start();
    controller.stop();

    expect(bridge.broadcastWatchdogState).toHaveBeenCalledWith("s3", null);
  });
});
