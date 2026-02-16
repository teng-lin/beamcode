import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerSignalHandlers } from "./signal-handler.js";

describe("registerSignalHandlers", () => {
  let registeredHandlers: Map<string, (...args: unknown[]) => void>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    registeredHandlers = new Map();

    vi.spyOn(process, "on").mockImplementation((event: string, handler: any) => {
      registeredHandlers.set(event, handler);
      return process;
    });

    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("registers SIGTERM and SIGINT handlers", () => {
    const cleanup = vi.fn().mockResolvedValue(undefined);
    registerSignalHandlers(cleanup);

    expect(registeredHandlers.has("SIGTERM")).toBe(true);
    expect(registeredHandlers.has("SIGINT")).toBe(true);
  });

  it("calls the cleanup function when a signal is received", async () => {
    const cleanup = vi.fn().mockResolvedValue(undefined);
    registerSignalHandlers(cleanup);

    const handler = registeredHandlers.get("SIGTERM")!;
    handler();

    // Let the microtask (cleanup promise) settle
    await vi.advanceTimersByTimeAsync(0);

    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("calls process.exit(0) after successful cleanup", async () => {
    const cleanup = vi.fn().mockResolvedValue(undefined);
    registerSignalHandlers(cleanup);

    const handler = registeredHandlers.get("SIGTERM")!;
    handler();

    await vi.advanceTimersByTimeAsync(0);

    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("calls process.exit(0) even when cleanup throws", async () => {
    const cleanup = vi.fn().mockRejectedValue(new Error("cleanup failed"));
    registerSignalHandlers(cleanup);

    const handler = registeredHandlers.get("SIGINT")!;
    handler();

    await vi.advanceTimersByTimeAsync(0);

    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("sets a force timer that calls process.exit(1) on timeout", async () => {
    // Cleanup that never resolves, simulating a stall
    const cleanup = vi.fn().mockReturnValue(new Promise(() => {}));
    const timeoutMs = 5_000;
    registerSignalHandlers(cleanup, timeoutMs);

    const handler = registeredHandlers.get("SIGTERM")!;
    handler();

    // Advance past the timeout
    await vi.advanceTimersByTimeAsync(timeoutMs);

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("is idempotent — second signal call is a no-op", async () => {
    const cleanup = vi.fn().mockReturnValue(new Promise(() => {}));
    registerSignalHandlers(cleanup);

    const handler = registeredHandlers.get("SIGTERM")!;
    handler();
    handler(); // second call should be ignored

    await vi.advanceTimersByTimeAsync(0);

    expect(cleanup).toHaveBeenCalledOnce();
  });
});
