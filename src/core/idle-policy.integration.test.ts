import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DomainEventBus } from "./domain-event-bus.js";
import { IdlePolicy } from "./idle-policy.js";

describe("IdlePolicy", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("closes idle disconnected sessions during periodic sweep", async () => {
    const bridge = {
      getAllSessions: vi.fn(() => [{ session_id: "s1" }]),
      getSession: vi.fn(() => ({
        id: "s1",
        cliConnected: false,
        consumerCount: 0,
        pendingPermissions: [],
        consumers: [],
        messageHistoryLength: 0,
        state: { session_id: "s1" },
        lastStatus: null,
        lastActivity: Date.now() - 5000,
      })),
      applyPolicyCommand: vi.fn(),
      closeSession: vi.fn(async () => {}),
    } as any;

    const reaper = new IdlePolicy({
      bridge,
      logger: { info: vi.fn(), warn: vi.fn() } as any,
      idleSessionTimeoutMs: 1000,
      domainEvents: new DomainEventBus(),
    });

    reaper.start();
    await vi.advanceTimersByTimeAsync(1000);

    expect(bridge.applyPolicyCommand).toHaveBeenCalledWith("s1", { type: "idle_reap" });
    expect(bridge.closeSession).toHaveBeenCalledWith("s1");
    reaper.stop();
  });

  it("runs an immediate debounced sweep on disconnect events", async () => {
    const domainEvents = new DomainEventBus();
    const bridge = {
      getAllSessions: vi.fn(() => [{ session_id: "s2" }]),
      getSession: vi.fn(() => ({
        id: "s2",
        cliConnected: false,
        consumerCount: 0,
        pendingPermissions: [],
        consumers: [],
        messageHistoryLength: 0,
        state: { session_id: "s2" },
        lastStatus: null,
        lastActivity: Date.now() - 200_000,
      })),
      applyPolicyCommand: vi.fn(),
      closeSession: vi.fn(async () => {}),
    } as any;

    const reaper = new IdlePolicy({
      bridge,
      logger: { info: vi.fn(), warn: vi.fn() } as any,
      idleSessionTimeoutMs: 100_000,
      domainEvents,
    });

    reaper.start();
    domainEvents.publishBridge("consumer:disconnected", {
      sessionId: "s2",
      consumerCount: 0,
      identity: { userId: "u1", displayName: "U", role: "participant" },
    });
    domainEvents.publishBridge("backend:disconnected", {
      sessionId: "s2",
      code: 1000,
      reason: "test",
    });

    await vi.advanceTimersByTimeAsync(1);
    await Promise.resolve();

    expect(bridge.closeSession).toHaveBeenCalledTimes(1);
    expect(bridge.applyPolicyCommand).toHaveBeenCalledWith("s2", { type: "idle_reap" });
    expect(bridge.closeSession).toHaveBeenCalledWith("s2");
    reaper.stop();
  });

  it("stops reacting to events after stop()", async () => {
    const domainEvents = new DomainEventBus();
    const bridge = {
      getAllSessions: vi.fn(() => [{ session_id: "s3" }]),
      getSession: vi.fn(() => ({
        id: "s3",
        cliConnected: false,
        consumerCount: 0,
        pendingPermissions: [],
        consumers: [],
        messageHistoryLength: 0,
        state: { session_id: "s3" },
        lastStatus: null,
        lastActivity: Date.now() - 200_000,
      })),
      applyPolicyCommand: vi.fn(),
      closeSession: vi.fn(async () => {}),
    } as any;

    const reaper = new IdlePolicy({
      bridge,
      logger: { info: vi.fn(), warn: vi.fn() } as any,
      idleSessionTimeoutMs: 100_000,
      domainEvents,
    });

    reaper.start();
    reaper.stop();

    domainEvents.publishBridge("backend:disconnected", {
      sessionId: "s3",
      code: 1000,
      reason: "after-stop",
    });
    await vi.advanceTimersByTimeAsync(10);
    await Promise.resolve();

    expect(bridge.closeSession).not.toHaveBeenCalled();
  });
});
