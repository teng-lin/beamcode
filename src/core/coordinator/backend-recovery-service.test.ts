import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../../interfaces/logger.js";
import type { SessionLauncher } from "../interfaces/session-launcher.js";
import type { SessionRegistry } from "../interfaces/session-registry.js";
import { BackendRecoveryService, type RecoveryBridge } from "./backend-recovery-service.js";

/** Flush microtasks + advance fake timers by the given ms. */
async function flush(ms = 1): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

function createMockDeps() {
  const launcher = {
    relaunch: vi.fn().mockResolvedValue(true),
  } as unknown as SessionLauncher;

  const registry = {
    getSession: vi.fn(),
    markConnected: vi.fn(),
  } as unknown as SessionRegistry;

  const bridge = {
    isBackendConnected: vi.fn().mockReturnValue(false),
    connectBackend: vi.fn().mockResolvedValue(undefined),
  } as unknown as RecoveryBridge;

  const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

  return { launcher, registry, bridge, logger };
}

function createService(overrides?: Partial<ReturnType<typeof createMockDeps>>) {
  const deps = { ...createMockDeps(), ...overrides };
  const service = new BackendRecoveryService({
    ...deps,
    relaunchDedupMs: 5000,
    initializeTimeoutMs: 5000,
    killGracePeriodMs: 5000,
  });
  return { service, ...deps };
}

describe("BackendRecoveryService", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------
  // Dedup: same session not relaunched twice
  // -------------------------------------------------------------------

  describe("dedup prevention", () => {
    it("does not relaunch the same session twice in rapid succession", async () => {
      const { service, registry, launcher } = createService();
      vi.mocked(registry.getSession).mockReturnValue({
        sessionId: "s1",
        pid: 1234,
        state: "exited",
        cwd: "/tmp",
        archived: false,
        createdAt: 1000,
      } as any);

      // First call should trigger relaunch
      void service.handleRelaunchNeeded("s1");
      await flush();
      expect(launcher.relaunch).toHaveBeenCalledTimes(1);

      // Second call while dedup is active should be skipped
      void service.handleRelaunchNeeded("s1");
      await flush();
      expect(launcher.relaunch).toHaveBeenCalledTimes(1);
    });

    it("allows relaunch after dedup timer expires", async () => {
      const { service, registry, launcher } = createService();
      vi.mocked(registry.getSession).mockReturnValue({
        sessionId: "s1",
        pid: 1234,
        state: "exited",
        cwd: "/tmp",
        archived: false,
        createdAt: 1000,
      } as any);

      void service.handleRelaunchNeeded("s1");
      await flush();
      expect(launcher.relaunch).toHaveBeenCalledTimes(1);

      // Advance past dedup window (5000ms)
      await vi.advanceTimersByTimeAsync(6000);

      void service.handleRelaunchNeeded("s1");
      await flush();
      expect(launcher.relaunch).toHaveBeenCalledTimes(2);
    });

    it("skips archived sessions", async () => {
      const { service, registry, launcher } = createService();
      vi.mocked(registry.getSession).mockReturnValue({
        sessionId: "s1",
        pid: 1234,
        state: "exited",
        cwd: "/tmp",
        archived: true,
        createdAt: 1000,
      } as any);

      void service.handleRelaunchNeeded("s1");
      await flush();
      expect(launcher.relaunch).not.toHaveBeenCalled();
    });

    it("skips unknown sessions", async () => {
      const { service, registry, launcher } = createService();
      vi.mocked(registry.getSession).mockReturnValue(undefined);

      void service.handleRelaunchNeeded("unknown");
      await flush();
      expect(launcher.relaunch).not.toHaveBeenCalled();
    });

    it("skips sessions in starting state (PID exists, still connecting)", async () => {
      const { service, registry, launcher } = createService();
      vi.mocked(registry.getSession).mockReturnValue({
        sessionId: "s1",
        pid: 1234,
        state: "starting",
        cwd: "/tmp",
        archived: false,
        createdAt: 1000,
      } as any);

      void service.handleRelaunchNeeded("s1");
      await flush();
      expect(launcher.relaunch).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------
  // Direct-connection sessions (no PID) — reconnect via bridge
  // -------------------------------------------------------------------

  describe("direct-connection reconnect", () => {
    it("reconnects via bridge.connectBackend for sessions without PID", async () => {
      const { service, registry, bridge } = createService();
      vi.mocked(registry.getSession).mockReturnValue({
        sessionId: "ext-1",
        pid: undefined,
        state: "exited",
        cwd: "/tmp",
        archived: false,
        adapterName: "codex",
        createdAt: 1000,
      } as any);
      vi.mocked(bridge.isBackendConnected).mockReturnValue(false);

      void service.handleRelaunchNeeded("ext-1");
      await flush();

      expect(bridge.connectBackend).toHaveBeenCalledWith("ext-1", {
        adapterOptions: expect.objectContaining({ cwd: "/tmp" }),
      });
      expect(registry.markConnected).toHaveBeenCalledWith("ext-1");
    });

    it("does not reconnect if backend is already connected", async () => {
      const { service, registry, bridge } = createService();
      vi.mocked(registry.getSession).mockReturnValue({
        sessionId: "ext-1",
        pid: undefined,
        state: "connected",
        cwd: "/tmp",
        archived: false,
        adapterName: "codex",
        createdAt: 1000,
      } as any);
      vi.mocked(bridge.isBackendConnected).mockReturnValue(true);

      void service.handleRelaunchNeeded("ext-1");
      await flush();

      expect(bridge.connectBackend).not.toHaveBeenCalled();
    });

    it("logs error on reconnect failure without throwing", async () => {
      const { service, registry, bridge, logger } = createService();
      vi.mocked(registry.getSession).mockReturnValue({
        sessionId: "ext-1",
        pid: undefined,
        state: "exited",
        cwd: "/tmp",
        archived: false,
        adapterName: "codex",
        createdAt: 1000,
      } as any);
      vi.mocked(bridge.isBackendConnected).mockReturnValue(false);
      vi.mocked(bridge.connectBackend).mockRejectedValue(new Error("network down"));

      void service.handleRelaunchNeeded("ext-1");
      await flush();

      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("Failed to reconnect"));
    });
  });

  // -------------------------------------------------------------------
  // clearDedupState
  // -------------------------------------------------------------------

  describe("clearDedupState", () => {
    it("allows immediate relaunch after clearing dedup state", async () => {
      const { service, registry, launcher } = createService();
      vi.mocked(registry.getSession).mockReturnValue({
        sessionId: "s1",
        pid: 1234,
        state: "exited",
        cwd: "/tmp",
        archived: false,
        createdAt: 1000,
      } as any);

      void service.handleRelaunchNeeded("s1");
      await flush();
      expect(launcher.relaunch).toHaveBeenCalledTimes(1);

      // Clear dedup state (simulates deleteSession)
      service.clearDedupState("s1");

      // Should allow immediate relaunch
      void service.handleRelaunchNeeded("s1");
      await flush();
      expect(launcher.relaunch).toHaveBeenCalledTimes(2);
    });

    it("is safe to call on unknown session", () => {
      const { service } = createService();
      expect(() => service.clearDedupState("nonexistent")).not.toThrow();
    });
  });

  // -------------------------------------------------------------------
  // stop
  // -------------------------------------------------------------------

  describe("stop", () => {
    it("clears all timers and dedup state", async () => {
      const { service, registry, launcher } = createService();
      vi.mocked(registry.getSession).mockReturnValue({
        sessionId: "s1",
        pid: 1234,
        state: "exited",
        cwd: "/tmp",
        archived: false,
        createdAt: 1000,
      } as any);

      void service.handleRelaunchNeeded("s1");
      await flush();
      expect(launcher.relaunch).toHaveBeenCalledTimes(1);

      service.stop();

      // Advancing timers should not cause errors after stop
      await vi.advanceTimersByTimeAsync(10000);
    });

    it("allows relaunch after stop + reset", async () => {
      const { service, registry, launcher } = createService();
      vi.mocked(registry.getSession).mockReturnValue({
        sessionId: "s1",
        pid: 1234,
        state: "exited",
        cwd: "/tmp",
        archived: false,
        createdAt: 1000,
      } as any);

      void service.handleRelaunchNeeded("s1");
      await flush();

      service.stop();
      service.reset();

      // After stop+reset, the dedup set was cleared, so a new relaunch should work
      void service.handleRelaunchNeeded("s1");
      await flush();
      expect(launcher.relaunch).toHaveBeenCalledTimes(2);
    });
  });
});
