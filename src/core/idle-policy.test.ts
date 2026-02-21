import { afterEach, describe, expect, it, vi } from "vitest";
import { DomainEventBus } from "./domain-event-bus.js";
import { IdlePolicy } from "./idle-policy.js";

describe("IdlePolicy", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("closes idle sessions and emits idle_reap policy command", async () => {
    vi.useFakeTimers();
    const domainEvents = new DomainEventBus();
    const bridge = {
      getAllSessions: vi.fn(() => [{ session_id: "s1" }]),
      getSession: vi.fn(() => ({
        id: "s1",
        cliConnected: false,
        consumerCount: 0,
        lastActivity: Date.now() - 20_000,
      })),
      closeSession: vi.fn(async () => undefined),
      applyPolicyCommand: vi.fn(),
      broadcastWatchdogState: vi.fn(),
    } as any;
    const logger = { info: vi.fn(), warn: vi.fn() } as any;

    const policy = new IdlePolicy({
      bridge,
      logger,
      idleSessionTimeoutMs: 5_000,
      domainEvents,
    });

    policy.start();
    await vi.advanceTimersByTimeAsync(1_000);
    await Promise.resolve();

    expect(bridge.applyPolicyCommand).toHaveBeenCalledWith("s1", { type: "idle_reap" });
    expect(bridge.closeSession).toHaveBeenCalledWith("s1");
    policy.stop();
  });
});
