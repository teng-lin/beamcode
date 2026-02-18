import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockExecFileSync = vi.hoisted(() => vi.fn(() => "/usr/bin/claude"));
vi.mock("node:child_process", () => ({ execFileSync: mockExecFileSync }));
vi.mock("node:crypto", () => ({ randomUUID: () => "test-session-id" }));

import type WebSocket from "ws";
import { MemoryStorage } from "../adapters/memory-storage.js";
import type { ProcessHandle, ProcessManager, SpawnOptions } from "../interfaces/process-manager.js";
import type { OnCLIConnection, WebSocketServerLike } from "../interfaces/ws-server.js";
import { MockBackendAdapter } from "../testing/adapter-test-helpers.js";
import type {
  BackendAdapter,
  BackendCapabilities,
  BackendSession,
  ConnectOptions,
} from "./interfaces/backend-adapter.js";
import type { InvertedConnectionAdapter } from "./interfaces/inverted-connection-adapter.js";
import { SessionManager } from "./session-manager.js";

// ---------------------------------------------------------------------------
// Mock ProcessManager (matches the real ProcessManager interface)
// ---------------------------------------------------------------------------

interface MockProcessHandle extends ProcessHandle {
  resolveExit: (code: number | null) => void;
  killCalls: string[];
}

class MockProcessManager implements ProcessManager {
  readonly spawnCalls: SpawnOptions[] = [];
  readonly spawnedProcesses: MockProcessHandle[] = [];
  private alivePids = new Set<number>();
  private nextPid = 10000;

  spawn(options: SpawnOptions): ProcessHandle {
    this.spawnCalls.push(options);
    const pid = this.nextPid++;
    this.alivePids.add(pid);
    let resolveExit: (code: number | null) => void;
    const exited = new Promise<number | null>((resolve) => {
      resolveExit = resolve;
    });
    const killCalls: string[] = [];
    const handle: MockProcessHandle = {
      pid,
      exited,
      kill(signal: "SIGTERM" | "SIGKILL" | "SIGINT" = "SIGTERM") {
        killCalls.push(signal);
      },
      stdout: null,
      stderr: null,
      resolveExit: (code: number | null) => {
        this.alivePids.delete(pid);
        resolveExit!(code);
      },
      killCalls,
    };
    this.spawnedProcesses.push(handle);
    return handle;
  }

  isAlive(pid: number): boolean {
    return this.alivePids.has(pid);
  }

  get lastProcess(): MockProcessHandle | undefined {
    return this.spawnedProcesses[this.spawnedProcesses.length - 1];
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SessionManager", () => {
  let mgr: SessionManager;
  let pm: MockProcessManager;
  let storage: MemoryStorage;
  const noopLogger = { info() {}, warn() {}, error() {} };

  beforeEach(() => {
    vi.clearAllMocks();
    pm = new MockProcessManager();
    storage = new MemoryStorage();
    mgr = new SessionManager({
      config: { port: 3456 },
      processManager: pm,
      storage,
      logger: noopLogger,
    });
  });

  // -----------------------------------------------------------------------
  // start / stop
  // -----------------------------------------------------------------------

  describe("start() and stop()", () => {
    it("starts without error", () => {
      expect(() => mgr.start()).not.toThrow();
    });

    it("stops gracefully", async () => {
      mgr.start();
      await expect(mgr.stop()).resolves.not.toThrow();
    });

    it("multiple start() calls are idempotent", () => {
      mgr.start();
      expect(() => mgr.start()).not.toThrow();
    });
  });

  // -----------------------------------------------------------------------
  // Wiring: backend:session_id → launcher.setCLISessionId
  // -----------------------------------------------------------------------

  describe("backend:session_id wiring", () => {
    it("forwards to launcher.setCLISessionId", () => {
      mgr.start();
      const info = mgr.launcher.launch({ cwd: "/tmp" });
      // Simulate the bridge emitting backend:session_id
      mgr.bridge.emit("backend:session_id" as any, {
        sessionId: info.sessionId,
        backendSessionId: "cli-abc-123",
      });

      const session = mgr.launcher.getSession(info.sessionId);
      expect(session?.cliSessionId).toBe("cli-abc-123");
    });
  });

  // -----------------------------------------------------------------------
  // Wiring: backend:connected → launcher.markConnected
  // -----------------------------------------------------------------------

  describe("backend:connected wiring", () => {
    it("forwards to launcher.markConnected", () => {
      mgr.start();
      const info = mgr.launcher.launch({ cwd: "/tmp" });
      expect(info.state).toBe("starting");

      mgr.bridge.emit("backend:connected" as any, { sessionId: info.sessionId });

      const session = mgr.launcher.getSession(info.sessionId);
      expect(session?.state).toBe("connected");
    });
  });

  // -----------------------------------------------------------------------
  // Wiring: backend:relaunch_needed → launcher.relaunch (with dedup)
  // -----------------------------------------------------------------------

  describe("backend:relaunch_needed wiring", () => {
    it("triggers launcher.relaunch", async () => {
      mgr.start();
      const info = mgr.launcher.launch({ cwd: "/tmp" });
      // Simulate the process exiting so relaunch is meaningful
      pm.lastProcess!.resolveExit(1);
      await pm.lastProcess!.exited;
      const spawnsBefore = pm.spawnCalls.length;

      mgr.bridge.emit("backend:relaunch_needed" as any, { sessionId: info.sessionId });
      // Allow async relaunch to run
      await new Promise((r) => setTimeout(r, 10));

      expect(pm.spawnCalls.length).toBeGreaterThan(spawnsBefore);
    });

    it("deduplicates rapid relaunch requests", async () => {
      mgr.start();
      const info = mgr.launcher.launch({ cwd: "/tmp" });
      pm.lastProcess!.resolveExit(1);
      await pm.lastProcess!.exited;
      const spawnsBefore = pm.spawnCalls.length;

      // Fire three rapid relaunch requests
      mgr.bridge.emit("backend:relaunch_needed" as any, { sessionId: info.sessionId });
      mgr.bridge.emit("backend:relaunch_needed" as any, { sessionId: info.sessionId });
      mgr.bridge.emit("backend:relaunch_needed" as any, { sessionId: info.sessionId });
      await new Promise((r) => setTimeout(r, 10));

      // Should only spawn once due to dedup
      expect(pm.spawnCalls.length).toBe(spawnsBefore + 1);
    });

    it("skips archived sessions", async () => {
      mgr.start();
      const info = mgr.launcher.launch({ cwd: "/tmp" });
      mgr.launcher.setArchived(info.sessionId, true);
      pm.lastProcess!.resolveExit(1);
      await pm.lastProcess!.exited;
      const spawnsBefore = pm.spawnCalls.length;

      mgr.bridge.emit("backend:relaunch_needed" as any, { sessionId: info.sessionId });
      await new Promise((r) => setTimeout(r, 10));

      expect(pm.spawnCalls.length).toBe(spawnsBefore);
    });
  });

  // -----------------------------------------------------------------------
  // Event forwarding
  // -----------------------------------------------------------------------

  describe("event forwarding", () => {
    it("re-emits bridge events", () => {
      mgr.start();
      const received: string[] = [];
      mgr.on("cli:connected", () => received.push("cli:connected"));

      mgr.bridge.emit("cli:connected" as any, { sessionId: "s1" });

      expect(received).toContain("cli:connected");
    });

    it("re-emits launcher events", () => {
      mgr.start();
      const received: unknown[] = [];
      mgr.on("process:spawned", (payload) => received.push(payload));

      mgr.launcher.launch({ cwd: "/tmp" });

      expect(received).toHaveLength(1);
      expect((received[0] as any).pid).toBeDefined();
    });
  });

  // -----------------------------------------------------------------------
  // Restore order (I6)
  // -----------------------------------------------------------------------

  describe("restore order", () => {
    it("restores launcher before bridge", () => {
      // Seed storage with a persisted session
      storage.saveSync({
        id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        state: {
          session_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
          model: "test",
          cwd: "/tmp",
          tools: [],
          permissionMode: "default",
          claude_code_version: "1.0",
          mcp_servers: [],
          agents: [],
          slash_commands: [],
          skills: [],
          total_cost_usd: 0,
          num_turns: 0,
          context_used_percent: 0,
          is_compacting: false,
          git_branch: "",
          is_worktree: false,
          repo_root: "",
          git_ahead: 0,
          git_behind: 0,
          total_lines_added: 0,
          total_lines_removed: 0,
        },
        messageHistory: [],
        pendingMessages: [],
        pendingPermissions: [],
      });

      mgr.start();

      // Bridge should have restored the session
      const snapshot = mgr.bridge.getSession("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
      expect(snapshot).toBeDefined();
      expect(snapshot!.state.model).toBe("test");
    });
  });

  // -----------------------------------------------------------------------
  // Stop kills all
  // -----------------------------------------------------------------------

  describe("stop", () => {
    it("kills all launched processes", async () => {
      mgr.start();
      mgr.launcher.launch({ cwd: "/tmp" });
      expect(pm.spawnedProcesses).toHaveLength(1);

      // Resolve the exit so kill completes
      setTimeout(() => pm.lastProcess!.resolveExit(0), 5);
      await mgr.stop();

      expect(pm.lastProcess!.killCalls).toContain("SIGTERM");
    });
  });

  // -----------------------------------------------------------------------
  // WebSocket server integration
  // -----------------------------------------------------------------------

  describe("WebSocket server integration", () => {
    it("starts and stops WS server when provided", async () => {
      const listenCalls: OnCLIConnection[] = [];
      const closeCalled: boolean[] = [];

      const mockServer: WebSocketServerLike = {
        async listen(onConnection) {
          listenCalls.push(onConnection);
        },
        async close() {
          closeCalled.push(true);
        },
      };

      const mgr = new SessionManager({
        config: { port: 3456 },
        processManager: pm,
        server: mockServer,
      });

      await mgr.start();
      expect(listenCalls).toHaveLength(1);

      await mgr.stop();
      expect(closeCalled).toHaveLength(1);
    });

    it("works without WS server (backwards compatible)", async () => {
      const mgr = new SessionManager({
        config: { port: 3456 },
        processManager: pm,
      });

      // Should not throw when no server provided
      await mgr.start();
      await mgr.stop();
    });

    it("wires CLI connections to onConnection callback", async () => {
      let capturedOnConnection: OnCLIConnection | null = null;

      const mockServer: WebSocketServerLike = {
        async listen(onConnection) {
          capturedOnConnection = onConnection;
        },
        async close() {},
      };

      const mgr = new SessionManager({
        config: { port: 3456 },
        processManager: pm,
        server: mockServer,
        // No adapter — socket should be closed
      });

      await mgr.start();
      expect(capturedOnConnection).not.toBeNull();

      // Simulate a CLI connection without an adapter
      const mockSocket = {
        send: vi.fn(),
        close: vi.fn(),
        on: vi.fn(),
      };

      capturedOnConnection!(mockSocket as any, "test-session-id");

      // Without an adapter, the socket should be closed
      expect(mockSocket.close).toHaveBeenCalled();

      await mgr.stop();
    });
  });

  // -----------------------------------------------------------------------
  // Timeout cleanup and relaunch dedup
  // -----------------------------------------------------------------------

  describe("timeout cleanup and relaunch dedup", () => {
    it("has no starting sessions when none launched", () => {
      mgr.start();
      expect(mgr.launcher.getStartingSessions()).toHaveLength(0);
    });

    it("launched session is accessible via getSession", () => {
      mgr.start();
      const info = mgr.launcher.launch({ cwd: "/tmp" });
      expect(info.sessionId).toBe("test-session-id");
      expect(mgr.launcher.getSession(info.sessionId)).toBeDefined();
    });
  });

  // -----------------------------------------------------------------------
  // Forwarded structured data APIs
  // -----------------------------------------------------------------------

  describe("Forwarded structured data APIs", () => {
    it("getSupportedModels forwards to bridge", () => {
      mgr.start();
      // No capabilities yet, should return empty
      expect(mgr.getSupportedModels("nonexistent")).toEqual([]);
    });

    it("getSupportedCommands forwards to bridge", () => {
      mgr.start();
      expect(mgr.getSupportedCommands("nonexistent")).toEqual([]);
    });

    it("getAccountInfo forwards to bridge", () => {
      mgr.start();
      expect(mgr.getAccountInfo("nonexistent")).toBeNull();
    });

    it("forwards capabilities:ready event", () => {
      mgr.start();
      const handler = vi.fn();
      mgr.on("capabilities:ready", handler);

      // Simulate the bridge emitting the event
      mgr.bridge.emit("capabilities:ready" as any, {
        sessionId: "sess-1",
        commands: [{ name: "/help", description: "Help" }],
        models: [{ value: "claude-sonnet-4-5-20250929", displayName: "Sonnet" }],
        account: { email: "test@test.com" },
      });

      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "sess-1" }));
    });

    it("forwards capabilities:timeout event", () => {
      mgr.start();
      const handler = vi.fn();
      mgr.on("capabilities:timeout", handler);

      mgr.bridge.emit("capabilities:timeout" as any, {
        sessionId: "sess-1",
      });

      expect(handler).toHaveBeenCalledWith({ sessionId: "sess-1" });
    });
  });

  // -----------------------------------------------------------------------
  // Reconnect watchdog (I4)
  // -----------------------------------------------------------------------

  describe("reconnect watchdog", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("relaunches sessions still in 'starting' state after grace period", async () => {
      const testStorage = new MemoryStorage();
      testStorage.saveLauncherState([
        {
          sessionId: "watchdog-sess",
          pid: 99999,
          state: "connected",
          cwd: "/tmp",
          archived: false,
        },
      ]);

      // Use a PM that reports pid 99999 as alive so restore sets state to "starting"
      const alivePm = new MockProcessManager();
      const origIsAlive = alivePm.isAlive.bind(alivePm);
      alivePm.isAlive = (pid: number) => pid === 99999 || origIsAlive(pid);

      const watchdogMgr = new SessionManager({
        config: { port: 3456, reconnectGracePeriodMs: 50 },
        processManager: alivePm,
        storage: testStorage,
        logger: noopLogger,
      });
      watchdogMgr.start();

      // Verify there are starting sessions that the watchdog found
      const starting = watchdogMgr.launcher.getStartingSessions();
      expect(starting.length).toBeGreaterThan(0);
      expect(starting[0].state).toBe("starting");

      // Advance past the grace period (50ms) and let async relaunch resolve
      await vi.advanceTimersByTimeAsync(100);

      // Relaunch calls spawnProcess which calls pm.spawn
      expect(alivePm.spawnCalls.length).toBeGreaterThan(0);

      // Resolve the spawned process so stop() doesn't hang
      if (alivePm.lastProcess) {
        alivePm.lastProcess.resolveExit(0);
      }
      await watchdogMgr.stop();
    });

    it("skips archived sessions in the watchdog", async () => {
      // Seed launcher state with an archived session
      const testStorage = new MemoryStorage();
      testStorage.saveLauncherState([
        {
          sessionId: "archived-sess",
          pid: 88888,
          state: "connected",
          cwd: "/tmp",
          archived: true,
        },
      ]);

      const alivePm = new MockProcessManager();
      const origIsAlive = alivePm.isAlive.bind(alivePm);
      alivePm.isAlive = (pid: number) => pid === 88888 || origIsAlive(pid);

      const watchdogMgr = new SessionManager({
        config: { port: 3456, reconnectGracePeriodMs: 500 },
        processManager: alivePm,
        storage: testStorage,
        logger: noopLogger,
      });
      watchdogMgr.start();

      // Session is in "starting" state (alive PID), but also archived
      const starting = watchdogMgr.launcher.getStartingSessions();
      expect(starting.length).toBeGreaterThan(0);
      expect(starting[0].archived).toBe(true);

      await vi.advanceTimersByTimeAsync(600);

      // No relaunch should happen because session is archived
      expect(alivePm.spawnCalls.length).toBe(0);

      await watchdogMgr.stop();
    });

    it("does not set a timer when there are no starting sessions", () => {
      const timerMgr = new SessionManager({
        config: { port: 3456, reconnectGracePeriodMs: 500 },
        processManager: pm,
        storage,
        logger: noopLogger,
      });
      timerMgr.start();

      // No sessions launched, so no starting sessions
      expect(timerMgr.launcher.getStartingSessions().length).toBe(0);

      // Advance timers — nothing should happen (no errors)
      vi.advanceTimersByTime(1000);

      timerMgr.stop();
    });
  });

  // -----------------------------------------------------------------------
  // Idle reaper
  // -----------------------------------------------------------------------

  describe("idle reaper", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("closes sessions with no connections that exceed the idle timeout", async () => {
      const idleAdapter = new MockBackendAdapter();
      const idleMgr = new SessionManager({
        config: { port: 3456, idleSessionTimeoutMs: 100 },
        processManager: pm,
        storage,
        logger: noopLogger,
        adapter: idleAdapter,
      });
      idleMgr.start();

      // Spy on closeSession to verify the reaper actually calls it
      const closeSpy = vi.spyOn(idleMgr.bridge, "closeSession");

      // Connect backend (replaces handleCLIOpen), then disconnect
      await idleMgr.bridge.connectBackend("idle-session");
      await idleMgr.bridge.disconnectBackend("idle-session");

      // Verify session exists and CLI is disconnected
      const snap1 = idleMgr.bridge.getSession("idle-session");
      expect(snap1).toBeDefined();
      expect(snap1!.cliConnected).toBe(false);
      expect(snap1!.consumerCount).toBe(0);

      // checkInterval = max(1000, 100/10) = 1000, so the first check is at 1000ms.
      // After advancing 1100ms, the check fires and idle time >= 100ms.
      await vi.advanceTimersByTimeAsync(1100);

      // Verify the idle reaper called closeSession
      expect(closeSpy).toHaveBeenCalledWith("idle-session");

      await idleMgr.stop();
    });

    it("skips sessions with active backend connections", async () => {
      const activeAdapter = new MockBackendAdapter();
      const idleMgr = new SessionManager({
        config: { port: 3456, idleSessionTimeoutMs: 100 },
        processManager: pm,
        storage,
        logger: noopLogger,
        adapter: activeAdapter,
      });
      idleMgr.start();

      // Connect backend (replaces handleCLIOpen)
      await idleMgr.bridge.connectBackend("active-session");

      // Verify backend is connected (isCliConnected checks backendSession)
      expect(idleMgr.bridge.isCliConnected("active-session")).toBe(true);

      // Advance well past idle timeout
      await vi.advanceTimersByTimeAsync(2000);

      // Session should still exist since backend is connected
      const snap = idleMgr.bridge.getSession("active-session");
      expect(snap).toBeDefined();
      expect(snap!.cliConnected).toBe(true);

      await idleMgr.stop();
    });

    it("does not start when idleSessionTimeoutMs is 0", () => {
      const noIdleMgr = new SessionManager({
        config: { port: 3456, idleSessionTimeoutMs: 0 },
        processManager: pm,
        storage,
        logger: noopLogger,
      });
      noIdleMgr.start();

      // Advance timers — nothing should break
      vi.advanceTimersByTime(5000);

      noIdleMgr.stop();
    });

    it("rejects negative idleSessionTimeoutMs via config validation", () => {
      expect(
        () =>
          new SessionManager({
            config: { port: 3456, idleSessionTimeoutMs: -1 },
            processManager: pm,
            storage,
            logger: noopLogger,
          }),
      ).toThrow("Invalid configuration");
    });
  });

  // -----------------------------------------------------------------------
  // Adapter-aware CLI routing
  // -----------------------------------------------------------------------

  describe("adapter-aware CLI routing", () => {
    const defaultCapabilities: BackendCapabilities = {
      streaming: true,
      permissions: true,
      slashCommands: true,
      availability: "local" as const,
      teams: true,
    };

    class MockInvertedAdapter implements InvertedConnectionAdapter {
      readonly name = "mock-inverted";
      readonly capabilities = defaultCapabilities;
      deliverSocketCalls: Array<{ sessionId: string; ws: unknown }> = [];
      deliverSocketResult = true;

      async connect(_options: ConnectOptions): Promise<BackendSession> {
        const noop = {
          [Symbol.asyncIterator]: () => ({
            next: () => new Promise<IteratorResult<never>>(() => {}),
          }),
        };
        return {
          sessionId: _options.sessionId,
          send: vi.fn(),
          sendRaw: vi.fn(),
          messages: noop as AsyncIterable<never>,
          close: vi.fn().mockResolvedValue(undefined),
        } as unknown as BackendSession;
      }

      deliverSocket(sessionId: string, ws: WebSocket): boolean {
        this.deliverSocketCalls.push({ sessionId, ws });
        return this.deliverSocketResult;
      }

      cancelPending(_sessionId: string): void {}
    }

    function createMockServer(): {
      server: WebSocketServerLike;
      getCapturedOnCLI: () => OnCLIConnection | null;
    } {
      let capturedOnCLI: OnCLIConnection | null = null;
      return {
        server: {
          async listen(onCLI) {
            capturedOnCLI = onCLI;
          },
          async close() {},
        },
        getCapturedOnCLI: () => capturedOnCLI,
      };
    }

    function createMockSocket() {
      const events: Record<string, Array<(...args: unknown[]) => void>> = {};
      return {
        socket: {
          send: vi.fn(),
          close: vi.fn(),
          on: (event: string, handler: (...args: unknown[]) => void) => {
            events[event] = events[event] || [];
            events[event].push(handler);
          },
        },
        events,
      };
    }

    it("with InvertedConnectionAdapter, CLI WS connection calls connectBackend then deliverSocket", async () => {
      const adapter = new MockInvertedAdapter();
      const { server, getCapturedOnCLI } = createMockServer();

      const adapterMgr = new SessionManager({
        config: { port: 3456 },
        processManager: pm,
        storage,
        logger: noopLogger,
        server,
        adapter,
      });

      await adapterMgr.start();
      const onCLI = getCapturedOnCLI();
      expect(onCLI).not.toBeNull();

      const { socket } = createMockSocket();
      onCLI!(socket as any, "adapter-session-1");

      // connectBackend + deliverSocket are async — wait for them
      await vi.waitFor(() => {
        expect(adapter.deliverSocketCalls).toHaveLength(1);
      });
      expect(adapter.deliverSocketCalls[0].sessionId).toBe("adapter-session-1");
      expect(adapter.deliverSocketCalls[0].ws).toBe(socket);

      // Backend session should be connected via adapter
      expect(adapterMgr.bridge.isCliConnected("adapter-session-1")).toBe(true);

      await adapterMgr.stop();
    });

    it("closes socket when deliverSocket returns false", async () => {
      const adapter = new MockInvertedAdapter();
      adapter.deliverSocketResult = false;
      const { server, getCapturedOnCLI } = createMockServer();

      const adapterMgr = new SessionManager({
        config: { port: 3456 },
        processManager: pm,
        storage,
        logger: noopLogger,
        server,
        adapter,
      });

      await adapterMgr.start();
      const onCLI = getCapturedOnCLI();
      expect(onCLI).not.toBeNull();

      const { socket } = createMockSocket();
      onCLI!(socket as any, "fallback-session");

      // connectBackend + deliverSocket are async — wait for them
      await vi.waitFor(() => {
        expect(adapter.deliverSocketCalls).toHaveLength(1);
      });
      expect(adapter.deliverSocketCalls[0].sessionId).toBe("fallback-session");

      // Socket should have been closed (deliverSocket returned false)
      expect(socket.close).toHaveBeenCalled();

      await adapterMgr.stop();
    });

    it("without adapter, closes the socket", async () => {
      const { server, getCapturedOnCLI } = createMockServer();

      const legacyMgr = new SessionManager({
        config: { port: 3456 },
        processManager: pm,
        storage,
        logger: noopLogger,
        server,
        // No adapter provided
      });

      await legacyMgr.start();
      const onCLI = getCapturedOnCLI();
      expect(onCLI).not.toBeNull();

      const { socket } = createMockSocket();
      onCLI!(socket as any, "no-adapter-session");

      // Socket should have been closed (no adapter to handle it)
      expect(socket.close).toHaveBeenCalled();

      await legacyMgr.stop();
    });
  });
});
