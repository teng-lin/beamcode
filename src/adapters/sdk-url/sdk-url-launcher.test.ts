import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));
vi.mock("node:crypto", () => ({ randomUUID: vi.fn(() => "test-uuid") }));

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { LauncherStateStorage } from "../../interfaces/storage.js";
import { noopLogger } from "../../testing/cli-message-factories.js";
import { type MockProcessHandle, MockProcessManager } from "../../testing/mock-process-manager.js";
import { SdkUrlLauncher, type SdkUrlLauncherOptions } from "./sdk-url-launcher.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createMockStorage(): LauncherStateStorage {
  return {
    saveLauncherState: vi.fn(),
    loadLauncherState: vi.fn(() => null),
  };
}

function createLauncher(overrides?: Partial<SdkUrlLauncherOptions>) {
  const pm = new MockProcessManager();
  const storage = createMockStorage();
  const launcher = new SdkUrlLauncher({
    processManager: pm,
    config: { port: 3456, defaultClaudeBinary: "claude" },
    storage,
    logger: noopLogger,
    ...overrides,
  });
  return { launcher, pm, storage };
}

function lastSpawnArgs(pm: MockProcessManager) {
  return pm.spawnCalls[pm.spawnCalls.length - 1];
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("SdkUrlLauncher", () => {
  let uuidCounter = 0;

  beforeEach(() => {
    vi.clearAllMocks();
    uuidCounter = 0;
    (randomUUID as ReturnType<typeof vi.fn>).mockImplementation(() => `test-uuid-${uuidCounter++}`);
    // Default: which resolves to the binary itself
    (execFileSync as ReturnType<typeof vi.fn>).mockImplementation(
      (_cmd: string, args: string[]) => `${args[0]}\n`,
    );
  });

  // ─── Binary validation ────────────────────────────────────────────────

  describe("binary validation", () => {
    it("rejects path traversal", () => {
      const { launcher } = createLauncher();
      const errorHandler = vi.fn();
      launcher.on("error", errorHandler);

      launcher.launch({ claudeBinary: "../malicious" });

      expect(errorHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({
            message: expect.stringContaining("Invalid CLI binary name"),
          }),
        }),
      );
    });

    it("accepts simple basename", () => {
      const { launcher, pm } = createLauncher();
      launcher.launch({ claudeBinary: "claude" });
      expect(pm.spawnCalls).toHaveLength(1);
    });

    it("accepts absolute path", () => {
      const { launcher, pm } = createLauncher();
      launcher.launch({ claudeBinary: "/usr/local/bin/claude" });
      expect(pm.spawnCalls).toHaveLength(1);
      expect(lastSpawnArgs(pm).command).toBe("/usr/local/bin/claude");
    });

    it("rejects special characters", () => {
      const { launcher } = createLauncher();
      const errorHandler = vi.fn();
      launcher.on("error", errorHandler);

      launcher.launch({ claudeBinary: "claude;rm -rf /" });

      expect(errorHandler).toHaveBeenCalled();
    });

    it("resolves basename via which", () => {
      (execFileSync as ReturnType<typeof vi.fn>).mockReturnValue("/resolved/path/claude\n");
      const { launcher, pm } = createLauncher();
      launcher.launch({});
      expect(lastSpawnArgs(pm).command).toBe("/resolved/path/claude");
    });
  });

  // ─── Env deny list ────────────────────────────────────────────────────

  describe("env deny list", () => {
    it("strips denied env vars (CLAUDECODE always removed)", () => {
      const origEnv = process.env;
      process.env = {
        ...origEnv,
        CLAUDECODE: "1",
        LD_PRELOAD: "evil.so",
        SAFE_VAR: "ok",
      };
      try {
        const { launcher, pm } = createLauncher();
        launcher.launch({});
        const spawnedEnv = lastSpawnArgs(pm).env!;
        expect(spawnedEnv.CLAUDECODE).toBeUndefined();
        expect(spawnedEnv.LD_PRELOAD).toBeUndefined();
        expect(spawnedEnv.SAFE_VAR).toBe("ok");
      } finally {
        process.env = origEnv;
      }
    });

    it("passes custom env through", () => {
      const { launcher, pm } = createLauncher();
      launcher.launch({ env: { MY_VAR: "hello" } });
      expect(lastSpawnArgs(pm).env!.MY_VAR).toBe("hello");
    });

    it("merges default env correctly", () => {
      const { launcher, pm } = createLauncher();
      launcher.launch({});
      // Should have PATH from process.env
      expect(lastSpawnArgs(pm).env!.PATH).toBeDefined();
    });
  });

  // ─── Session lifecycle ────────────────────────────────────────────────

  describe("session lifecycle", () => {
    it("launch creates session with 'starting' state", () => {
      const { launcher } = createLauncher();
      const info = launcher.launch({});
      expect(info.state).toBe("starting");
      expect(info.sessionId).toBe("test-uuid-0");
    });

    it("launch enforces maxConcurrentSessions", () => {
      const { launcher } = createLauncher({
        config: { port: 3456, maxConcurrentSessions: 1 },
      });
      launcher.launch({});
      expect(() => launcher.launch({})).toThrow("Maximum concurrent sessions");
    });

    it("relaunch returns false for unknown session", async () => {
      const { launcher } = createLauncher();
      const result = await launcher.relaunch("nonexistent");
      expect(result).toBe(false);
    });

    it("relaunch kills old process and sets state to starting", async () => {
      const { launcher, pm } = createLauncher();
      launcher.launch({});
      const proc = pm.lastProcess!;
      proc.resolveExit(0);
      // Wait for the exit handler
      await new Promise((r) => setTimeout(r, 50));

      // Set a cliSessionId for resume
      launcher.setCLISessionId("test-uuid-0", "cli-sess-1");
      const result = await launcher.relaunch("test-uuid-0");
      expect(result).toBe(true);
      expect(launcher.getSession("test-uuid-0")!.state).toBe("starting");
    });

    it("relaunch returns false when circuit breaker is open", async () => {
      const { launcher, pm } = createLauncher({
        config: {
          port: 3456,
          cliRestartCircuitBreaker: {
            failureThreshold: 1,
            windowMs: 60000,
            recoveryTimeMs: 30000,
            successThreshold: 2,
          },
          resumeFailureThresholdMs: 100000, // high so exits count as crashes
        },
      });

      // Launch and immediately crash to trip the breaker
      launcher.launch({});
      pm.lastProcess!.resolveExit(1);
      await new Promise((r) => setTimeout(r, 50));

      const result = await launcher.relaunch("test-uuid-0");
      expect(result).toBe(false);
    });

    it("spawnCLI marks exited when spawnProcess returns null", () => {
      const { launcher, pm, storage } = createLauncher();
      pm.failNextSpawn();
      // Attach error listener to prevent unhandled error
      launcher.on("error", () => {});

      const info = launcher.launch({});
      expect(info.state).toBe("exited");
      expect(info.exitCode).toBe(-1);
      expect(storage.saveLauncherState).toHaveBeenCalled();
    });
  });

  // ─── Resume failure detection ─────────────────────────────────────────

  describe("resume failure detection", () => {
    it("quick exit after --resume clears cliSessionId and emits process:resume_failed", async () => {
      const { launcher, pm } = createLauncher({
        config: {
          port: 3456,
          resumeFailureThresholdMs: 100000, // set high so ~50ms is "quick"
        },
      });
      launcher.launch({});
      launcher.setCLISessionId("test-uuid-0", "cli-sess-1");

      // Force a relaunch with --resume
      pm.lastProcess!.resolveExit(0);
      await new Promise((r) => setTimeout(r, 50));
      await launcher.relaunch("test-uuid-0");

      const resumeFailedHandler = vi.fn();
      launcher.on("process:resume_failed", resumeFailedHandler);

      // Simulate quick exit of relaunched process
      pm.lastProcess!.resolveExit(1);
      await new Promise((r) => setTimeout(r, 50));

      expect(resumeFailedHandler).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: "test-uuid-0" }),
      );
      expect(launcher.getSession("test-uuid-0")!.cliSessionId).toBeUndefined();
    });
  });

  // ─── State mutations ──────────────────────────────────────────────────

  describe("state mutations", () => {
    it("markConnected transitions state and records circuit breaker success", () => {
      const { launcher } = createLauncher();
      launcher.launch({});
      const connectedHandler = vi.fn();
      launcher.on("process:connected", connectedHandler);

      launcher.markConnected("test-uuid-0");

      expect(launcher.getSession("test-uuid-0")!.state).toBe("connected");
      expect(connectedHandler).toHaveBeenCalledWith({ sessionId: "test-uuid-0" });
    });

    it("markConnected when state is exited is a no-op", async () => {
      const { launcher, pm } = createLauncher();
      launcher.launch({});
      pm.lastProcess!.resolveExit(0);
      await new Promise((r) => setTimeout(r, 50));

      launcher.markConnected("test-uuid-0");
      expect(launcher.getSession("test-uuid-0")!.state).toBe("exited");
    });

    it("setCLISessionId persists", () => {
      const { launcher, storage } = createLauncher();
      launcher.launch({});
      launcher.setCLISessionId("test-uuid-0", "cli-abc");
      expect(launcher.getSession("test-uuid-0")!.cliSessionId).toBe("cli-abc");
      expect(storage.saveLauncherState).toHaveBeenCalled();
    });

    it("kill marks exited and returns boolean", async () => {
      const { launcher, pm } = createLauncher();
      launcher.launch({});
      // Resolve exit on kill
      const proc = pm.lastProcess!;
      setTimeout(() => proc.resolveExit(null), 10);
      const result = await launcher.kill("test-uuid-0");
      expect(result).toBe(true);
      expect(launcher.getSession("test-uuid-0")!.state).toBe("exited");
    });

    it("pruneExited removes only exited sessions", async () => {
      const { launcher, pm } = createLauncher();
      launcher.launch({});
      launcher.launch({});

      // Exit the first one
      pm.spawnedProcesses[0].resolveExit(0);
      await new Promise((r) => setTimeout(r, 50));

      const pruned = launcher.pruneExited();
      expect(pruned).toBe(1);
      expect(launcher.listSessions()).toHaveLength(1);
    });

    it("listSessions, getSession, isAlive, getStartingSessions return correct data", () => {
      const { launcher } = createLauncher();
      launcher.launch({});

      expect(launcher.listSessions()).toHaveLength(1);
      expect(launcher.getSession("test-uuid-0")).toBeDefined();
      expect(launcher.isAlive("test-uuid-0")).toBe(true);
      expect(launcher.isAlive("nonexistent")).toBe(false);
      expect(launcher.getStartingSessions()).toHaveLength(1);
    });
  });

  // ─── Persistence ──────────────────────────────────────────────────────

  describe("persistence", () => {
    it("restoreFromStorage recovers live sessions", () => {
      const { launcher, pm, storage } = createLauncher();
      (storage.loadLauncherState as ReturnType<typeof vi.fn>).mockReturnValue([
        {
          sessionId: "restored-1",
          pid: 99999,
          state: "connected",
          cwd: "/tmp",
          createdAt: Date.now(),
        },
      ]);
      // Mark PID as alive in mock PM
      (pm as any).alivePids.add(99999);

      const count = launcher.restoreFromStorage();
      expect(count).toBe(1);
      expect(launcher.getSession("restored-1")).toBeDefined();
      expect(launcher.getSession("restored-1")!.state).toBe("starting");
    });

    it("restoreFromStorage marks dead PIDs as exited", () => {
      const { launcher, storage } = createLauncher();
      (storage.loadLauncherState as ReturnType<typeof vi.fn>).mockReturnValue([
        {
          sessionId: "dead-1",
          pid: 88888,
          state: "connected",
          cwd: "/tmp",
          createdAt: Date.now(),
        },
      ]);

      const count = launcher.restoreFromStorage();
      expect(count).toBe(0);
      expect(launcher.getSession("dead-1")!.state).toBe("exited");
    });

    it("restoreFromStorage with empty storage is a no-op", () => {
      const { launcher } = createLauncher();
      const count = launcher.restoreFromStorage();
      expect(count).toBe(0);
    });
  });

  // ─── Spawn args ───────────────────────────────────────────────────────

  describe("spawn args", () => {
    it("passes --sdk-url with URL template", () => {
      const { launcher, pm } = createLauncher();
      launcher.launch({});
      const args = lastSpawnArgs(pm).args!;
      expect(args).toContain("--sdk-url");
      expect(args[args.indexOf("--sdk-url") + 1]).toContain(
        "ws://localhost:3456/ws/cli/test-uuid-0",
      );
    });

    it("passes --model, --permission-mode, --allowedTools correctly", () => {
      const { launcher, pm } = createLauncher();
      launcher.launch({
        model: "opus",
        permissionMode: "plan",
        allowedTools: ["Bash", "Read"],
      });
      const args = lastSpawnArgs(pm).args!;
      expect(args).toContain("--model");
      expect(args[args.indexOf("--model") + 1]).toBe("opus");
      expect(args).toContain("--permission-mode");
      expect(args[args.indexOf("--permission-mode") + 1]).toBe("plan");
      // Two --allowedTools entries
      const allowedIdxs = args.reduce<number[]>((acc, a, i) => {
        if (a === "--allowedTools") acc.push(i);
        return acc;
      }, []);
      expect(allowedIdxs).toHaveLength(2);
      expect(args[allowedIdxs[0] + 1]).toBe("Bash");
      expect(args[allowedIdxs[1] + 1]).toBe("Read");
    });

    it("beforeSpawn hook is called with correct args", () => {
      const beforeSpawn = vi.fn();
      const { launcher, pm } = createLauncher({ beforeSpawn });
      launcher.launch({});
      expect(beforeSpawn).toHaveBeenCalledWith(
        "test-uuid-0",
        expect.objectContaining({
          command: expect.any(String),
          args: expect.any(Array),
          cwd: expect.any(String),
        }),
      );
    });

    it("beforeSpawn hook throws → spawn aborted, error emitted", () => {
      const beforeSpawn = vi.fn(() => {
        throw new Error("hook error");
      });
      const { launcher, pm } = createLauncher({ beforeSpawn });
      const errorHandler = vi.fn();
      launcher.on("error", errorHandler);

      const info = launcher.launch({});
      expect(pm.spawnCalls).toHaveLength(0);
      expect(info.state).toBe("exited");
      expect(errorHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({ message: "hook error" }),
        }),
      );
    });
  });

  // ─── Event subscriptions ──────────────────────────────────────────────

  describe("events", () => {
    it("process:spawned emitted with sessionId and pid", () => {
      const { launcher } = createLauncher();
      const handler = vi.fn();
      launcher.on("process:spawned", handler);

      launcher.launch({});

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: "test-uuid-0",
          pid: expect.any(Number),
        }),
      );
    });

    it("process:exited emitted with circuitBreaker snapshot when breaker not closed", async () => {
      const { launcher, pm } = createLauncher({
        config: {
          port: 3456,
          cliRestartCircuitBreaker: {
            failureThreshold: 1,
            windowMs: 60000,
            recoveryTimeMs: 30000,
            successThreshold: 2,
          },
          resumeFailureThresholdMs: 100000, // high so exits count as crashes
        },
      });
      const handler = vi.fn();
      launcher.on("process:exited", handler);

      launcher.launch({});
      pm.lastProcess!.resolveExit(1);
      await new Promise((r) => setTimeout(r, 50));

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: "test-uuid-0",
          circuitBreaker: expect.objectContaining({
            state: expect.any(String),
            failureCount: expect.any(Number),
          }),
        }),
      );
    });
  });
});
