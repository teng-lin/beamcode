import { beforeEach, describe, expect, it, vi } from "vitest";

const mockExecFileSync = vi.hoisted(() => vi.fn(() => "/usr/bin/claude"));
vi.mock("node:child_process", () => ({ execFileSync: mockExecFileSync }));
vi.mock("node:crypto", () => ({ randomUUID: () => "test-session-id" }));

import { MemoryStorage } from "../adapters/memory-storage.js";
import type { ProcessHandle, ProcessManager, SpawnOptions } from "../interfaces/process-manager.js";
import { ClaudeLauncher as CLILauncher } from "../adapters/claude/claude-launcher.js";

// ---------------------------------------------------------------------------
// Mock ProcessManager
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
  private _shouldFailSpawn = false;

  spawn(options: SpawnOptions): ProcessHandle {
    this.spawnCalls.push(options);
    if (this._shouldFailSpawn) {
      throw new Error("Mock spawn failure");
    }
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

  failNextSpawn(): void {
    this._shouldFailSpawn = true;
  }

  resetSpawnFailure(): void {
    this._shouldFailSpawn = false;
  }

  get lastProcess(): MockProcessHandle | undefined {
    return this.spawnedProcesses[this.spawnedProcesses.length - 1];
  }

  clear(): void {
    this.spawnCalls.length = 0;
    this.spawnedProcesses.length = 0;
    this.alivePids.clear();
    this._shouldFailSpawn = false;
  }
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let launcher: CLILauncher;
let pm: MockProcessManager;
let storage: MemoryStorage;

beforeEach(() => {
  vi.clearAllMocks();
  pm = new MockProcessManager();
  storage = new MemoryStorage();
  launcher = new CLILauncher({
    processManager: pm,
    config: { port: 3456 },
    storage,
    logger: { info() {}, warn() {}, error() {} },
  });
  mockExecFileSync.mockReturnValue("/usr/bin/claude");
});

// ===========================================================================
// 1. Launch
// ===========================================================================

describe("launch", () => {
  it("returns SdkSessionInfo with state starting", () => {
    const info = launcher.launch();
    expect(info.sessionId).toBe("test-session-id");
    expect(info.state).toBe("starting");
    expect(info.cwd).toBe(process.cwd());
    expect(info.createdAt).toBeGreaterThan(0);
  });

  it("spawns CLI with correct default args", () => {
    launcher.launch();
    expect(pm.spawnCalls).toHaveLength(1);
    const call = pm.spawnCalls[0];
    expect(call.command).toBe("/usr/bin/claude");
    expect(call.args).toContain("--sdk-url");
    expect(call.args).toContain("ws://localhost:3456/ws/cli/test-session-id");
    expect(call.args).toContain("--print");
    expect(call.args).toContain("--output-format");
    expect(call.args).toContain("stream-json");
    expect(call.args).toContain("--input-format");
    expect(call.args).toContain("--verbose");
    expect(call.args).toContain("-p");
    expect(call.args).toContain("");
  });

  it("passes --model when provided", () => {
    launcher.launch({ model: "opus" });
    const args = pm.spawnCalls[0].args;
    expect(args).toContain("--model");
    expect(args).toContain("opus");
  });

  it("passes --permission-mode when provided", () => {
    launcher.launch({ permissionMode: "plan" });
    const args = pm.spawnCalls[0].args;
    expect(args).toContain("--permission-mode");
    expect(args).toContain("plan");
  });

  it("passes --allowedTools for each tool", () => {
    launcher.launch({ allowedTools: ["Bash", "Read", "Write"] });
    const args = pm.spawnCalls[0].args;
    const toolIndices = args.map((a, i) => (a === "--allowedTools" ? i : -1)).filter((i) => i >= 0);
    expect(toolIndices).toHaveLength(3);
    expect(args[toolIndices[0] + 1]).toBe("Bash");
    expect(args[toolIndices[1] + 1]).toBe("Read");
    expect(args[toolIndices[2] + 1]).toBe("Write");
  });

  it("uses custom binary when specified", () => {
    launcher.launch({ claudeBinary: "/opt/bin/claude-dev" });
    expect(pm.spawnCalls[0].command).toBe("/opt/bin/claude-dev");
  });

  it("merges env vars into spawn environment", () => {
    launcher.launch({ env: { MY_VAR: "hello" } });
    const env = pm.spawnCalls[0].env!;
    expect(env.MY_VAR).toBe("hello");
    // CLAUDECODE should be removed to avoid the nesting guard
    expect(env.CLAUDECODE).toBeUndefined();
  });

  it("throws when max concurrent sessions reached", () => {
    // maxConcurrentSessions: 1 ensures the very first launch fills the limit,
    // since the UUID mock always returns the same ID a second launch() would
    // overwrite the first session. Use limit=1 so a single session fills it,
    // then seed a second session manually to trigger the limit.
    const small = new CLILauncher({
      processManager: pm,
      config: { port: 3456, maxConcurrentSessions: 1 },
      storage,
      logger: { info() {}, warn() {}, error() {} },
    });
    small.launch();
    // The session map has one entry with state "starting". Now try to launch
    // another -- but since randomUUID returns the same ID, the existing entry
    // is still active and counts toward the limit. The launcher checks active
    // count BEFORE creating the new entry, so this should exceed the limit.
    // However the same sessionId overwrites. We need a different approach:
    // Pre-seed a session via restoreFromStorage so we have a different ID.
    storage.saveLauncherState([
      {
        sessionId: "existing-active",
        state: "connected",
        pid: 10000,
        cwd: "/tmp",
        createdAt: Date.now(),
      },
    ]);
    const small2 = new CLILauncher({
      processManager: pm,
      config: { port: 3456, maxConcurrentSessions: 1 },
      storage,
      logger: { info() {}, warn() {}, error() {} },
    });
    // Make PID 10000 alive
    pm.spawn({ command: "dummy", args: [], cwd: "/" });
    small2.restoreFromStorage();
    // Now there is 1 active session (state: "starting" after restore)
    expect(() => small2.launch()).toThrow(/Maximum concurrent sessions/);
  });

  it("uses custom cwd when provided", () => {
    launcher.launch({ cwd: "/tmp/work" });
    expect(pm.spawnCalls[0].cwd).toBe("/tmp/work");
    const info = launcher.getSession("test-session-id");
    expect(info?.cwd).toBe("/tmp/work");
  });
});

// ===========================================================================
// 2. Relaunch
// ===========================================================================

describe("relaunch", () => {
  it("returns false for unknown session", async () => {
    const result = await launcher.relaunch("nonexistent");
    expect(result).toBe(false);
  });

  it("kills existing process before relaunching", async () => {
    launcher.launch();
    const oldProc = pm.lastProcess!;
    // Simulate the old process exiting quickly after SIGTERM
    const relaunchPromise = launcher.relaunch("test-session-id");
    oldProc.resolveExit(0);
    const result = await relaunchPromise;
    expect(result).toBe(true);
    expect(oldProc.killCalls).toContain("SIGTERM");
    // A new spawn should have occurred
    expect(pm.spawnCalls).toHaveLength(2);
  });

  it("passes --resume when backendSessionId is set", async () => {
    launcher.launch();
    launcher.setBackendSessionId("test-session-id", "cli-internal-id-123");
    const oldProc = pm.lastProcess!;
    const relaunchPromise = launcher.relaunch("test-session-id");
    oldProc.resolveExit(0);
    await relaunchPromise;
    const lastCall = pm.spawnCalls[pm.spawnCalls.length - 1];
    expect(lastCall.args).toContain("--resume");
    expect(lastCall.args).toContain("cli-internal-id-123");
  });

  it("detects resume failure when process exits immediately", async () => {
    // Use a very short resume failure threshold
    const quickLauncher = new CLILauncher({
      processManager: pm,
      config: { port: 3456, resumeFailureThresholdMs: 60000 },
      storage,
      logger: { info() {}, warn() {}, error() {} },
    });
    quickLauncher.launch();
    quickLauncher.setBackendSessionId("test-session-id", "cli-sess-abc");
    const oldProc = pm.lastProcess!;
    const events: string[] = [];
    quickLauncher.on("process:resume_failed", () => {
      events.push("resume_failed");
    });
    const relaunchPromise = quickLauncher.relaunch("test-session-id");
    oldProc.resolveExit(0);
    await relaunchPromise;
    // Now resolve the new process immediately (simulating fast crash)
    const newProc = pm.lastProcess!;
    newProc.resolveExit(1);
    // Give the exit handler time to run
    await new Promise((r) => setTimeout(r, 50));
    expect(events).toContain("resume_failed");
    // backendSessionId should be cleared
    const session = quickLauncher.getSession("test-session-id");
    expect(session?.backendSessionId).toBeUndefined();
  });

  it("handles relaunch when process was from a previous server (no managed handle)", async () => {
    // Seed storage with a session that has a PID but no managed process
    const oldSession = {
      sessionId: "restored-id",
      state: "starting" as const,
      pid: 99999,
      cwd: "/tmp",
      createdAt: Date.now(),
    };
    storage.saveLauncherState([oldSession]);
    // Create a fresh launcher that restores
    const freshPm = new MockProcessManager();
    // The PID is not alive in our mock, so isAlive returns false
    const freshLauncher = new CLILauncher({
      processManager: freshPm,
      config: { port: 3456 },
      storage,
      logger: { info() {}, warn() {}, error() {} },
    });
    freshLauncher.restoreFromStorage();
    // The session was marked exited because the PID is dead
    const session = freshLauncher.getSession("restored-id");
    expect(session?.state).toBe("exited");
  });
});

// ===========================================================================
// 3. Kill
// ===========================================================================

describe("kill", () => {
  it("sends SIGTERM then SIGKILL if process does not exit in time", async () => {
    const fastKill = new CLILauncher({
      processManager: pm,
      config: { port: 3456, killGracePeriodMs: 50 },
      storage,
      logger: { info() {}, warn() {}, error() {} },
    });
    fastKill.launch();
    const proc = pm.lastProcess!;
    // Don't resolve exit -- let the timeout fire
    const killPromise = fastKill.kill("test-session-id");
    // Wait for SIGKILL
    await new Promise((r) => setTimeout(r, 100));
    proc.resolveExit(null);
    await killPromise;
    expect(proc.killCalls).toContain("SIGTERM");
    expect(proc.killCalls).toContain("SIGKILL");
  });

  it("only sends SIGTERM when process exits promptly", async () => {
    launcher.launch();
    const proc = pm.lastProcess!;
    const killPromise = launcher.kill("test-session-id");
    proc.resolveExit(0);
    await killPromise;
    expect(proc.killCalls).toEqual(["SIGTERM"]);
  });

  it("returns false for unknown session", async () => {
    const result = await launcher.kill("nonexistent");
    expect(result).toBe(false);
  });

  it("killAll kills all active sessions", async () => {
    // Need unique IDs -- but crypto mock returns same ID.
    // Work around by launching with maxConcurrentSessions: 1 isn't needed;
    // the session map uses the same key so only one session gets created.
    // Let's just test that killAll invokes kill for the active process.
    launcher.launch();
    const proc = pm.lastProcess!;
    const killAllPromise = launcher.killAll();
    proc.resolveExit(0);
    await killAllPromise;
    expect(proc.killCalls).toContain("SIGTERM");
    const session = launcher.getSession("test-session-id");
    expect(session?.state).toBe("exited");
  });

  it("handles kill on already-exited process gracefully", async () => {
    launcher.launch();
    const proc = pm.lastProcess!;
    // Process exits on its own
    proc.resolveExit(0);
    await new Promise((r) => setTimeout(r, 20));
    // Now try to kill -- should return false since process handle is removed
    const result = await launcher.kill("test-session-id");
    expect(result).toBe(false);
  });
});

// ===========================================================================
// 4. Session management
// ===========================================================================

describe("session management", () => {
  it("listSessions returns all sessions", () => {
    launcher.launch();
    const sessions = launcher.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].sessionId).toBe("test-session-id");
  });

  it("getSession returns session by id", () => {
    launcher.launch();
    const session = launcher.getSession("test-session-id");
    expect(session).toBeDefined();
    expect(session?.sessionId).toBe("test-session-id");
  });

  it("getSession returns undefined for unknown id", () => {
    expect(launcher.getSession("nope")).toBeUndefined();
  });

  it("isAlive returns true for non-exited sessions", () => {
    launcher.launch();
    expect(launcher.isAlive("test-session-id")).toBe(true);
  });

  it("isAlive returns false for exited sessions", async () => {
    launcher.launch();
    const proc = pm.lastProcess!;
    proc.resolveExit(0);
    await new Promise((r) => setTimeout(r, 20));
    expect(launcher.isAlive("test-session-id")).toBe(false);
  });

  it("isAlive returns false for unknown sessions", () => {
    expect(launcher.isAlive("nonexistent")).toBe(false);
  });

  it("removeSession deletes session from maps", () => {
    launcher.launch();
    launcher.removeSession("test-session-id");
    expect(launcher.getSession("test-session-id")).toBeUndefined();
    expect(launcher.listSessions()).toHaveLength(0);
  });

  it("pruneExited removes exited sessions and returns count", async () => {
    launcher.launch();
    const proc = pm.lastProcess!;
    proc.resolveExit(0);
    await new Promise((r) => setTimeout(r, 20));
    const pruned = launcher.pruneExited();
    expect(pruned).toBe(1);
    expect(launcher.listSessions()).toHaveLength(0);
  });

  it("pruneExited returns 0 when nothing to prune", () => {
    launcher.launch();
    expect(launcher.pruneExited()).toBe(0);
  });

  it("setArchived sets the archived flag", () => {
    launcher.launch();
    launcher.setArchived("test-session-id", true);
    expect(launcher.getSession("test-session-id")?.archived).toBe(true);
    launcher.setArchived("test-session-id", false);
    expect(launcher.getSession("test-session-id")?.archived).toBe(false);
  });

  it("getStartingSessions returns only starting sessions", () => {
    launcher.launch();
    const starting = launcher.getStartingSessions();
    expect(starting).toHaveLength(1);
    expect(starting[0].state).toBe("starting");
  });

  it("getStartingSessions excludes connected sessions", () => {
    launcher.launch();
    launcher.markConnected("test-session-id");
    expect(launcher.getStartingSessions()).toHaveLength(0);
  });
});

// ===========================================================================
// 5. Persistence
// ===========================================================================

describe("persistence", () => {
  it("restoreFromStorage recovers alive PIDs", () => {
    // Save a session with a PID that our mock considers alive
    const fakeSession = {
      sessionId: "old-session",
      state: "connected" as const,
      pid: 10000,
      cwd: "/home/user",
      createdAt: Date.now() - 60000,
    };
    storage.saveLauncherState([fakeSession]);

    // Create a new PM where PID 10000 is alive
    const pm2 = new MockProcessManager();
    // Spawn a process to make PID 10000 alive
    pm2.spawn({ command: "test", args: [], cwd: "/" });
    // pm2's PID 10000 is now alive

    const launcher2 = new CLILauncher({
      processManager: pm2,
      config: { port: 3456 },
      storage,
      logger: { info() {}, warn() {}, error() {} },
    });
    const recovered = launcher2.restoreFromStorage();
    expect(recovered).toBe(1);
    const session = launcher2.getSession("old-session");
    expect(session?.state).toBe("starting");
  });

  it("restoreFromStorage marks dead PIDs as exited", () => {
    const fakeSession = {
      sessionId: "dead-session",
      state: "connected" as const,
      pid: 55555,
      cwd: "/home/user",
      createdAt: Date.now() - 60000,
    };
    storage.saveLauncherState([fakeSession]);

    const launcher2 = new CLILauncher({
      processManager: pm,
      config: { port: 3456 },
      storage,
      logger: { info() {}, warn() {}, error() {} },
    });
    const recovered = launcher2.restoreFromStorage();
    expect(recovered).toBe(0);
    const session = launcher2.getSession("dead-session");
    expect(session?.state).toBe("exited");
    expect(session?.exitCode).toBe(-1);
  });

  it("restoreFromStorage returns 0 with no storage", () => {
    const noStorage = new CLILauncher({
      processManager: pm,
      config: { port: 3456 },
      logger: { info() {}, warn() {}, error() {} },
    });
    expect(noStorage.restoreFromStorage()).toBe(0);
  });

  it("restoreFromStorage returns 0 with empty/null storage data", () => {
    storage.saveLauncherState(null);
    expect(launcher.restoreFromStorage()).toBe(0);
  });

  it("persistState saves session data to storage on launch", () => {
    launcher.launch();
    const data = storage.loadLauncherState<any[]>();
    expect(data).toBeDefined();
    expect(data).toHaveLength(1);
    expect(data![0].sessionId).toBe("test-session-id");
  });

  it("persistState is called when markConnected changes state", () => {
    launcher.launch();
    launcher.markConnected("test-session-id");
    const data = storage.loadLauncherState<any[]>();
    expect(data![0].state).toBe("connected");
  });

  it("persistState is called when setBackendSessionId is set", () => {
    launcher.launch();
    launcher.setBackendSessionId("test-session-id", "cli-abc");
    const data = storage.loadLauncherState<any[]>();
    expect(data![0].backendSessionId).toBe("cli-abc");
  });
});

// ===========================================================================
// 6. CLI binary validation
// ===========================================================================

describe("CLI binary validation", () => {
  it("accepts valid binary names", () => {
    launcher.launch({ claudeBinary: "/usr/local/bin/claude" });
    expect(pm.spawnCalls).toHaveLength(1);
  });

  it("accepts simple names without path", () => {
    launcher.launch({ claudeBinary: "claude" });
    expect(pm.spawnCalls).toHaveLength(1);
  });

  it("accepts names with dots and underscores", () => {
    launcher.launch({ claudeBinary: "claude_dev.2" });
    expect(pm.spawnCalls).toHaveLength(1);
  });

  it("rejects binary with shell metacharacters (semicolon)", () => {
    const errors: any[] = [];
    launcher.on("error", (e) => errors.push(e));
    launcher.launch({ claudeBinary: "claude; rm -rf /" });
    expect(pm.spawnCalls).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0].source).toBe("cli-launcher");
    expect(errors[0].error.message).toMatch(/Invalid CLI binary name/);
  });

  it("rejects binary with backticks", () => {
    const errors: any[] = [];
    launcher.on("error", (e) => errors.push(e));
    launcher.launch({ claudeBinary: "`evil`" });
    expect(pm.spawnCalls).toHaveLength(0);
    expect(errors).toHaveLength(1);
  });

  it("rejects binary with spaces", () => {
    const errors: any[] = [];
    launcher.on("error", (e) => errors.push(e));
    launcher.launch({ claudeBinary: "claude code" });
    expect(pm.spawnCalls).toHaveLength(0);
    expect(errors).toHaveLength(1);
  });

  it("rejects binary with $() subshell", () => {
    const errors: any[] = [];
    launcher.on("error", (e) => errors.push(e));
    launcher.launch({ claudeBinary: "$(whoami)" });
    expect(pm.spawnCalls).toHaveLength(0);
  });

  it("marks session as exited on invalid binary", () => {
    // Must attach error listener to prevent Node EventEmitter from throwing
    launcher.on("error", () => {});
    launcher.launch({ claudeBinary: "bad binary!" });
    const session = launcher.getSession("test-session-id");
    expect(session?.state).toBe("exited");
    expect(session?.exitCode).toBe(-1);
  });
});

// ===========================================================================
// 7. beforeSpawn hook
// ===========================================================================

describe("beforeSpawn hook", () => {
  it("is called before spawn with sessionId and spawnOptions", () => {
    const hook = vi.fn();
    const hookedLauncher = new CLILauncher({
      processManager: pm,
      config: { port: 3456 },
      storage,
      logger: { info() {}, warn() {}, error() {} },
      beforeSpawn: hook,
    });
    hookedLauncher.launch({ cwd: "/tmp/test" });
    expect(hook).toHaveBeenCalledOnce();
    const [sessionId, opts] = hook.mock.calls[0];
    expect(sessionId).toBe("test-session-id");
    expect(opts.command).toBe("/usr/bin/claude");
    expect(opts.cwd).toBe("/tmp/test");
    // Spawn should have been called AFTER the hook
    expect(pm.spawnCalls).toHaveLength(1);
  });

  it("prevents spawn when hook throws", () => {
    const errors: any[] = [];
    const hookedLauncher = new CLILauncher({
      processManager: pm,
      config: { port: 3456 },
      storage,
      logger: { info() {}, warn() {}, error() {} },
      beforeSpawn: () => {
        throw new Error("Blocked by policy");
      },
    });
    hookedLauncher.on("error", (e) => errors.push(e));
    hookedLauncher.launch();
    expect(pm.spawnCalls).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0].source).toBe("cli-launcher:beforeSpawn");
    expect(errors[0].error.message).toBe("Blocked by policy");
    const session = hookedLauncher.getSession("test-session-id");
    expect(session?.state).toBe("exited");
  });
});

// ===========================================================================
// 8. Env deny list
// ===========================================================================

describe("env deny list", () => {
  it("strips default denied env vars", () => {
    // Default envDenyList: ["LD_PRELOAD", "DYLD_INSERT_LIBRARIES", "NODE_OPTIONS"]
    // Set these in process.env temporarily
    const origLD = process.env.LD_PRELOAD;
    const origDYLD = process.env.DYLD_INSERT_LIBRARIES;
    const origNode = process.env.NODE_OPTIONS;
    process.env.LD_PRELOAD = "evil.so";
    process.env.DYLD_INSERT_LIBRARIES = "evil.dylib";
    process.env.NODE_OPTIONS = "--require=evil.js";
    try {
      launcher.launch();
      const env = pm.spawnCalls[0].env!;
      expect(env.LD_PRELOAD).toBeUndefined();
      expect(env.DYLD_INSERT_LIBRARIES).toBeUndefined();
      expect(env.NODE_OPTIONS).toBeUndefined();
    } finally {
      // Restore
      if (origLD === undefined) delete process.env.LD_PRELOAD;
      else process.env.LD_PRELOAD = origLD;
      if (origDYLD === undefined) delete process.env.DYLD_INSERT_LIBRARIES;
      else process.env.DYLD_INSERT_LIBRARIES = origDYLD;
      if (origNode === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = origNode;
    }
  });

  it("strips custom denied env vars", () => {
    const orig = process.env.SECRET_KEY;
    process.env.SECRET_KEY = "supersecret";
    try {
      const customLauncher = new CLILauncher({
        processManager: pm,
        config: { port: 3456, envDenyList: ["SECRET_KEY"] },
        storage,
        logger: { info() {}, warn() {}, error() {} },
      });
      customLauncher.launch();
      const env = pm.spawnCalls[0].env!;
      expect(env.SECRET_KEY).toBeUndefined();
    } finally {
      if (orig === undefined) delete process.env.SECRET_KEY;
      else process.env.SECRET_KEY = orig;
    }
  });

  it("does not strip vars when envDenyList is empty", () => {
    const orig = process.env.KEEP_ME;
    process.env.KEEP_ME = "keep";
    try {
      const customLauncher = new CLILauncher({
        processManager: pm,
        config: { port: 3456, envDenyList: [] },
        storage,
        logger: { info() {}, warn() {}, error() {} },
      });
      customLauncher.launch();
      const env = pm.spawnCalls[0].env!;
      expect(env.KEEP_ME).toBe("keep");
    } finally {
      if (orig === undefined) delete process.env.KEEP_ME;
      else process.env.KEEP_ME = orig;
    }
  });
});

// ===========================================================================
// 9. Process events
// ===========================================================================

describe("process events", () => {
  it("emits process:spawned on launch", () => {
    const events: any[] = [];
    launcher.on("process:spawned", (e) => events.push(e));
    launcher.launch();
    expect(events).toHaveLength(1);
    expect(events[0].sessionId).toBe("test-session-id");
    expect(events[0].pid).toBe(10000);
  });

  it("emits process:exited when process exits", async () => {
    const events: any[] = [];
    launcher.on("process:exited", (e) => events.push(e));
    launcher.launch();
    pm.lastProcess!.resolveExit(42);
    await new Promise((r) => setTimeout(r, 20));
    expect(events).toHaveLength(1);
    expect(events[0].sessionId).toBe("test-session-id");
    expect(events[0].exitCode).toBe(42);
    expect(events[0].uptimeMs).toBeGreaterThanOrEqual(0);
  });

  it("emits process:connected on markConnected", () => {
    const events: any[] = [];
    launcher.on("process:connected", (e) => events.push(e));
    launcher.launch();
    launcher.markConnected("test-session-id");
    expect(events).toHaveLength(1);
    expect(events[0].sessionId).toBe("test-session-id");
  });

  it("emits error event on invalid binary", () => {
    const errors: any[] = [];
    launcher.on("error", (e) => errors.push(e));
    launcher.launch({ claudeBinary: "bad;binary" });
    expect(errors).toHaveLength(1);
    expect(errors[0].source).toBe("cli-launcher");
    expect(errors[0].sessionId).toBe("test-session-id");
  });

  it("emits error event on spawn failure", () => {
    pm.failNextSpawn();
    const errors: any[] = [];
    launcher.on("error", (e) => errors.push(e));
    launcher.launch();
    expect(errors).toHaveLength(1);
    expect(errors[0].source).toBe("cli-launcher:spawn");
    expect(errors[0].error.message).toBe("Mock spawn failure");
  });
});

// ===========================================================================
// 10. markConnected and setBackendSessionId
// ===========================================================================

describe("markConnected and setBackendSessionId", () => {
  it("markConnected transitions state from starting to connected", () => {
    launcher.launch();
    launcher.markConnected("test-session-id");
    expect(launcher.getSession("test-session-id")?.state).toBe("connected");
  });

  it("markConnected does nothing for unknown session", () => {
    // Should not throw
    launcher.markConnected("nonexistent");
  });

  it("markConnected does nothing for exited session", async () => {
    launcher.launch();
    pm.lastProcess!.resolveExit(0);
    await new Promise((r) => setTimeout(r, 20));
    launcher.markConnected("test-session-id");
    expect(launcher.getSession("test-session-id")?.state).toBe("exited");
  });

  it("setBackendSessionId stores the CLI internal session ID", () => {
    launcher.launch();
    launcher.setBackendSessionId("test-session-id", "internal-abc-123");
    expect(launcher.getSession("test-session-id")?.backendSessionId).toBe("internal-abc-123");
  });

  it("setBackendSessionId does nothing for unknown session", () => {
    // Should not throw
    launcher.setBackendSessionId("nonexistent", "abc");
  });
});

// ===========================================================================
// 11. WebSocket URL template
// ===========================================================================

describe("custom cliWebSocketUrlTemplate", () => {
  it("uses template function to build SDK URL", () => {
    const templateLauncher = new CLILauncher({
      processManager: pm,
      config: {
        port: 8080,
        cliWebSocketUrlTemplate: (id) => `wss://example.com/cli/${id}`,
      },
      storage,
      logger: { info() {}, warn() {}, error() {} },
    });
    templateLauncher.launch();
    const args = pm.spawnCalls[0].args;
    const sdkUrlIndex = args.indexOf("--sdk-url");
    expect(args[sdkUrlIndex + 1]).toBe("wss://example.com/cli/test-session-id");
  });

  it("falls back to default URL when no template is set", () => {
    launcher.launch();
    const args = pm.spawnCalls[0].args;
    const sdkUrlIndex = args.indexOf("--sdk-url");
    expect(args[sdkUrlIndex + 1]).toBe("ws://localhost:3456/ws/cli/test-session-id");
  });
});

// ===========================================================================
// 12. Spawn failure handling
// ===========================================================================

describe("spawn failure handling", () => {
  it("marks session as exited on spawn failure", () => {
    pm.failNextSpawn();
    launcher.on("error", () => {}); // prevent unhandled error throw
    launcher.launch();
    const session = launcher.getSession("test-session-id");
    expect(session?.state).toBe("exited");
    expect(session?.exitCode).toBe(-1);
  });

  it("emits error event on spawn failure", () => {
    pm.failNextSpawn();
    const errors: any[] = [];
    launcher.on("error", (e) => errors.push(e));
    launcher.launch();
    expect(errors).toHaveLength(1);
    expect(errors[0].source).toBe("cli-launcher:spawn");
    expect(errors[0].error.message).toBe("Mock spawn failure");
    expect(errors[0].sessionId).toBe("test-session-id");
  });

  it("persists state after spawn failure", () => {
    pm.failNextSpawn();
    launcher.on("error", () => {}); // prevent unhandled error throw
    launcher.launch();
    const data = storage.loadLauncherState<any[]>();
    expect(data).toBeDefined();
    expect(data![0].state).toBe("exited");
  });

  it("does not store process handle on spawn failure", async () => {
    pm.failNextSpawn();
    launcher.on("error", () => {}); // prevent unhandled error throw
    launcher.launch();
    // kill should return false since no process handle exists
    const killResult = await launcher.kill("test-session-id");
    expect(killResult).toBe(false);
  });
});
