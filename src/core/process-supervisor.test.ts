import { beforeEach, describe, expect, it } from "vitest";
import type { ProcessHandle, ProcessManager, SpawnOptions } from "../interfaces/process-manager.js";
import type { SupervisorEventMap } from "./process-supervisor.js";
import { ProcessSupervisor } from "./process-supervisor.js";

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
  private nextPid = 10000;
  private _shouldFailSpawn = false;

  spawn(options: SpawnOptions): ProcessHandle {
    this.spawnCalls.push(options);
    if (this._shouldFailSpawn) {
      throw new Error("Mock spawn failure");
    }
    const pid = this.nextPid++;
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
      resolveExit: (code: number | null) => resolveExit!(code),
      killCalls,
    };
    this.spawnedProcesses.push(handle);
    return handle;
  }

  isAlive(_pid: number): boolean {
    return false;
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
}

// ---------------------------------------------------------------------------
// Concrete test subclass
// ---------------------------------------------------------------------------

class TestSupervisor extends ProcessSupervisor<SupervisorEventMap> {
  readonly exitedSessions: Array<{
    sessionId: string;
    exitCode: number | null;
    uptimeMs: number;
  }> = [];

  protected buildSpawnArgs(
    _sessionId: string,
    options: unknown,
  ): { command: string; args: string[]; cwd: string; env?: Record<string, string | undefined> } {
    const opts = options as { command: string; args: string[]; cwd: string };
    return { command: opts.command, args: opts.args, cwd: opts.cwd };
  }

  protected override onProcessExited(
    sessionId: string,
    exitCode: number | null,
    uptimeMs: number,
  ): void {
    this.exitedSessions.push({ sessionId, exitCode, uptimeMs });
  }

  /** Expose spawnProcess for testing. */
  testSpawn(sessionId: string, options: unknown): ProcessHandle | null {
    return this.spawnProcess(sessionId, options);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const noopLogger = { info() {}, warn() {}, error() {} };

let supervisor: TestSupervisor;
let pm: MockProcessManager;

beforeEach(() => {
  pm = new MockProcessManager();
  supervisor = new TestSupervisor({
    processManager: pm,
    logger: noopLogger,
    killGracePeriodMs: 50,
    crashThresholdMs: 100,
  });
});

describe("spawnProcess", () => {
  it("spawns a process and emits process:spawned", () => {
    const events: any[] = [];
    supervisor.on("process:spawned", (e) => events.push(e));

    const proc = supervisor.testSpawn("sess-1", {
      command: "/usr/bin/test",
      args: ["--flag"],
      cwd: "/tmp",
    });

    expect(proc).not.toBeNull();
    expect(proc!.pid).toBe(10000);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ sessionId: "sess-1", pid: 10000 });
  });

  it("returns null and emits error on spawn failure", () => {
    pm.failNextSpawn();
    const errors: any[] = [];
    supervisor.on("error", (e) => errors.push(e));

    const proc = supervisor.testSpawn("sess-1", {
      command: "test",
      args: [],
      cwd: "/tmp",
    });

    expect(proc).toBeNull();
    expect(errors).toHaveLength(1);
    expect(errors[0].source).toBe("supervisor:spawn");
    expect(errors[0].error.message).toBe("Mock spawn failure");
  });

  it("tracks process handle after spawn", () => {
    supervisor.testSpawn("sess-1", { command: "test", args: [], cwd: "/" });
    expect(supervisor.hasProcess("sess-1")).toBe(true);
    expect(supervisor.getPid("sess-1")).toBe(10000);
  });
});

describe("kill escalation", () => {
  it("sends SIGTERM then SIGKILL if process does not exit in time", async () => {
    supervisor.testSpawn("sess-1", { command: "test", args: [], cwd: "/" });
    const proc = pm.lastProcess!;

    const killPromise = supervisor.killProcess("sess-1");
    // Wait for SIGKILL timeout
    await new Promise((r) => setTimeout(r, 100));
    proc.resolveExit(null);
    await killPromise;

    expect(proc.killCalls).toContain("SIGTERM");
    expect(proc.killCalls).toContain("SIGKILL");
  });

  it("only sends SIGTERM when process exits promptly", async () => {
    supervisor.testSpawn("sess-1", { command: "test", args: [], cwd: "/" });
    const proc = pm.lastProcess!;

    const killPromise = supervisor.killProcess("sess-1");
    proc.resolveExit(0);
    await killPromise;

    expect(proc.killCalls).toEqual(["SIGTERM"]);
  });

  it("returns false for unknown session", async () => {
    const result = await supervisor.killProcess("nonexistent");
    expect(result).toBe(false);
  });

  it("removes process handle after kill", async () => {
    supervisor.testSpawn("sess-1", { command: "test", args: [], cwd: "/" });
    const proc = pm.lastProcess!;
    const killPromise = supervisor.killProcess("sess-1");
    proc.resolveExit(0);
    await killPromise;
    expect(supervisor.hasProcess("sess-1")).toBe(false);
  });
});

describe("killAllProcesses", () => {
  it("kills all tracked processes", async () => {
    supervisor.testSpawn("sess-1", { command: "test", args: [], cwd: "/" });
    supervisor.testSpawn("sess-2", { command: "test", args: [], cwd: "/" });

    const procs = [...pm.spawnedProcesses];
    const killAllPromise = supervisor.killAllProcesses();
    for (const p of procs) p.resolveExit(0);
    await killAllPromise;

    expect(supervisor.hasProcess("sess-1")).toBe(false);
    expect(supervisor.hasProcess("sess-2")).toBe(false);
  });
});

describe("circuit breaker", () => {
  it("records failure when process exits quickly (crash)", async () => {
    supervisor.testSpawn("sess-1", { command: "test", args: [], cwd: "/" });
    const proc = pm.lastProcess!;

    // Exit immediately (< crashThresholdMs of 100)
    proc.resolveExit(1);
    await new Promise((r) => setTimeout(r, 20));

    // canRestart should still be true after one failure (threshold is 5)
    expect(supervisor.canRestart()).toBe(true);
  });

  it("opens circuit breaker after repeated quick failures", async () => {
    // Default failureThreshold is 5
    for (let i = 0; i < 6; i++) {
      supervisor.testSpawn(`sess-${i}`, { command: "test", args: [], cwd: "/" });
      const proc = pm.lastProcess!;
      proc.resolveExit(1);
      await new Promise((r) => setTimeout(r, 10));
    }

    // After 5+ failures, circuit breaker should be open
    // (6 spawns = 6 monitor exits recording failure + potential spawn error failures)
    // The base monitor records a failure for each quick exit
    expect(supervisor.canRestart()).toBe(false);
  });

  it("records success when process runs longer than crash threshold", async () => {
    const longSupervisor = new TestSupervisor({
      processManager: pm,
      logger: noopLogger,
      killGracePeriodMs: 50,
      crashThresholdMs: 10, // Very short for testing
    });

    longSupervisor.testSpawn("sess-1", { command: "test", args: [], cwd: "/" });
    const proc = pm.lastProcess!;

    // Wait longer than crashThresholdMs
    await new Promise((r) => setTimeout(r, 20));
    proc.resolveExit(0);
    await new Promise((r) => setTimeout(r, 10));

    // Should still be restartable (success was recorded)
    expect(longSupervisor.canRestart()).toBe(true);
  });
});

describe("process exit monitoring", () => {
  it("emits process:exited with exitCode and uptimeMs", async () => {
    const events: any[] = [];
    supervisor.on("process:exited", (e) => events.push(e));

    supervisor.testSpawn("sess-1", { command: "test", args: [], cwd: "/" });
    pm.lastProcess!.resolveExit(42);
    await new Promise((r) => setTimeout(r, 20));

    expect(events).toHaveLength(1);
    expect(events[0].sessionId).toBe("sess-1");
    expect(events[0].exitCode).toBe(42);
    expect(events[0].uptimeMs).toBeGreaterThanOrEqual(0);
  });

  it("calls onProcessExited hook", async () => {
    supervisor.testSpawn("sess-1", { command: "test", args: [], cwd: "/" });
    pm.lastProcess!.resolveExit(0);
    await new Promise((r) => setTimeout(r, 20));

    expect(supervisor.exitedSessions).toHaveLength(1);
    expect(supervisor.exitedSessions[0].sessionId).toBe("sess-1");
    expect(supervisor.exitedSessions[0].exitCode).toBe(0);
  });

  it("removes process handle after exit", async () => {
    supervisor.testSpawn("sess-1", { command: "test", args: [], cwd: "/" });
    expect(supervisor.hasProcess("sess-1")).toBe(true);

    pm.lastProcess!.resolveExit(0);
    await new Promise((r) => setTimeout(r, 20));

    expect(supervisor.hasProcess("sess-1")).toBe(false);
  });
});

describe("PID tracking", () => {
  it("getPid returns pid for tracked session", () => {
    supervisor.testSpawn("sess-1", { command: "test", args: [], cwd: "/" });
    expect(supervisor.getPid("sess-1")).toBe(10000);
  });

  it("getPid returns undefined for unknown session", () => {
    expect(supervisor.getPid("nonexistent")).toBeUndefined();
  });

  it("hasProcess returns false for unknown session", () => {
    expect(supervisor.hasProcess("nonexistent")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Helpers for stream piping tests
// ---------------------------------------------------------------------------

function createMockStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

function createErrorStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.error(new Error("stream error"));
    },
  });
}

/** MockProcessManager that attaches stdout/stderr streams to spawned handles. */
class StreamMockProcessManager extends MockProcessManager {
  stdout: ReadableStream<Uint8Array> | null = null;
  stderr: ReadableStream<Uint8Array> | null = null;

  override spawn(options: SpawnOptions): ProcessHandle {
    const handle = super.spawn(options);
    // Replace the null streams with configured ones
    return { ...handle, stdout: this.stdout, stderr: this.stderr };
  }
}

function createStreamSupervisor(streamPm: StreamMockProcessManager): TestSupervisor {
  return new TestSupervisor({
    processManager: streamPm,
    logger: noopLogger,
    killGracePeriodMs: 50,
    crashThresholdMs: 100,
  });
}

describe("stdout/stderr piping", () => {
  const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms));

  it("emits process:stdout events when stdout stream has data", async () => {
    const streamPm = new StreamMockProcessManager();
    streamPm.stdout = createMockStream(["hello\n", "world\n"]);
    const sv = createStreamSupervisor(streamPm);

    const stdoutEvents: any[] = [];
    sv.on("process:stdout", (e) => stdoutEvents.push(e));
    sv.testSpawn("sess-stdout", { command: "test", args: [], cwd: "/" });
    await tick();

    expect(stdoutEvents.length).toBeGreaterThanOrEqual(1);
    expect(stdoutEvents[0].sessionId).toBe("sess-stdout");
    const allData = stdoutEvents.map((e) => e.data).join("");
    expect(allData).toContain("hello");
    expect(allData).toContain("world");
  });

  it("emits process:stderr events when stderr stream has data", async () => {
    const streamPm = new StreamMockProcessManager();
    streamPm.stderr = createMockStream(["error output\n"]);
    const sv = createStreamSupervisor(streamPm);

    const stderrEvents: any[] = [];
    sv.on("process:stderr", (e) => stderrEvents.push(e));
    sv.testSpawn("sess-stderr", { command: "test", args: [], cwd: "/" });
    await tick();

    expect(stderrEvents.length).toBeGreaterThanOrEqual(1);
    expect(stderrEvents[0].sessionId).toBe("sess-stderr");
    expect(stderrEvents[0].data).toContain("error output");
  });

  it("does not throw when stream errors", async () => {
    const streamPm = new StreamMockProcessManager();
    streamPm.stdout = createErrorStream();
    const sv = createStreamSupervisor(streamPm);

    sv.testSpawn("sess-err-stream", { command: "test", args: [], cwd: "/" });
    await tick();

    expect(sv.hasProcess("sess-err-stream")).toBe(true);
  });

  it("skips empty/whitespace-only chunks", async () => {
    const streamPm = new StreamMockProcessManager();
    streamPm.stdout = createMockStream(["  \n", "real data\n", "\t\n"]);
    const sv = createStreamSupervisor(streamPm);

    const stdoutEvents: any[] = [];
    sv.on("process:stdout", (e) => stdoutEvents.push(e));
    sv.testSpawn("sess-whitespace", { command: "test", args: [], cwd: "/" });
    await tick();

    const nonEmptyEvents = stdoutEvents.filter((e) => e.data.trim().length > 0);
    expect(nonEmptyEvents.length).toBeGreaterThanOrEqual(1);
    expect(nonEmptyEvents[0].data).toContain("real data");
  });

  it("pipes both stdout and stderr simultaneously", async () => {
    const streamPm = new StreamMockProcessManager();
    streamPm.stdout = createMockStream(["stdout line\n"]);
    streamPm.stderr = createMockStream(["stderr line\n"]);
    const sv = createStreamSupervisor(streamPm);

    const stdoutEvents: any[] = [];
    const stderrEvents: any[] = [];
    sv.on("process:stdout", (e) => stdoutEvents.push(e));
    sv.on("process:stderr", (e) => stderrEvents.push(e));
    sv.testSpawn("sess-both", { command: "test", args: [], cwd: "/" });
    await tick();

    expect(stdoutEvents.length).toBeGreaterThanOrEqual(1);
    expect(stderrEvents.length).toBeGreaterThanOrEqual(1);
    expect(stdoutEvents[0].data).toContain("stdout line");
    expect(stderrEvents[0].data).toContain("stderr line");
  });
});

describe("error source prefix", () => {
  it("uses custom error source prefix", () => {
    pm.failNextSpawn();
    const errors: any[] = [];
    supervisor.on("error", (e) => errors.push(e));

    // Use the 3-arg form via a custom subclass that exposes it
    class CustomPrefixSupervisor extends ProcessSupervisor<SupervisorEventMap> {
      protected buildSpawnArgs(
        _sessionId: string,
        options: unknown,
      ): { command: string; args: string[]; cwd: string } {
        const o = options as { command: string; args: string[]; cwd: string };
        return { command: o.command, args: o.args, cwd: o.cwd };
      }

      testSpawnWithPrefix(sessionId: string, options: unknown): ProcessHandle | null {
        return this.spawnProcess(sessionId, options, "my-launcher");
      }
    }

    const customPm = new MockProcessManager();
    customPm.failNextSpawn();
    const custom = new CustomPrefixSupervisor({
      processManager: customPm,
      logger: noopLogger,
    });
    const customErrors: any[] = [];
    custom.on("error", (e) => customErrors.push(e));
    custom.testSpawnWithPrefix("sess-1", { command: "test", args: [], cwd: "/" });

    expect(customErrors).toHaveLength(1);
    expect(customErrors[0].source).toBe("my-launcher:spawn");
  });
});
