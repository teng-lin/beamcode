import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SocketRegistry } from "./socket-registry.js";

// Minimal mock for WebSocket
function createMockWs(): any {
  return { send: vi.fn(), close: vi.fn(), readyState: 1 };
}

describe("SocketRegistry", () => {
  let registry: SocketRegistry;

  beforeEach(() => {
    registry = new SocketRegistry();
  });

  it("register + deliverSocket resolves promise", async () => {
    const mockWs = createMockWs();
    const promise = registry.register("sess-1");
    const delivered = registry.deliverSocket("sess-1", mockWs);

    expect(delivered).toBe(true);
    expect(await promise).toBe(mockWs);
  });

  it("timeout rejects promise", async () => {
    vi.useFakeTimers();
    try {
      const promise = registry.register("sess-1", 100);
      vi.advanceTimersByTime(101);
      await expect(promise).rejects.toThrow(/timed out/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("deliverSocket for unknown session returns false", () => {
    const mockWs = createMockWs();
    expect(registry.deliverSocket("unknown", mockWs)).toBe(false);
  });

  it("cancel rejects promise with cancellation error", async () => {
    const promise = registry.register("sess-1");
    registry.cancel("sess-1");
    await expect(promise).rejects.toThrow(/cancelled/);
  });

  it("cancel for unknown session is no-op", () => {
    registry.cancel("unknown"); // should not throw
  });

  it("register same sessionId twice throws", () => {
    registry.register("sess-1");
    expect(() => registry.register("sess-1")).toThrow(/already has a pending/);
  });

  it("hasPending returns true for registered, false after delivery", async () => {
    const mockWs = createMockWs();
    const promise = registry.register("sess-1");

    expect(registry.hasPending("sess-1")).toBe(true);

    registry.deliverSocket("sess-1", mockWs);

    expect(registry.hasPending("sess-1")).toBe(false);

    // Consume the promise to avoid unhandled rejection
    await promise;
  });

  it("hasPending returns false after cancel", async () => {
    const promise = registry.register("sess-1");
    registry.cancel("sess-1");

    expect(registry.hasPending("sess-1")).toBe(false);

    // Consume the rejection to avoid unhandled rejection
    await promise.catch(() => {});
  });
});
