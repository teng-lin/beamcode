import { beforeEach, describe, expect, it } from "vitest";
import type { ProcessHandle, ProcessManager, SpawnOptions } from "../interfaces/process-manager.js";
import { ChildProcessSupervisor } from "./child-process-supervisor.js";

interface MockProcessHandle extends ProcessHandle {
  resolveExit: (code: number | null) => void;
}

class MockProcessManager implements ProcessManager {
  readonly spawnCalls: SpawnOptions[] = [];
  readonly handles: MockProcessHandle[] = [];
  private nextPid = 10000;

  spawn(options: SpawnOptions): ProcessHandle {
    this.spawnCalls.push(options);
    const pid = this.nextPid++;
    let resolveExit: (code: number | null) => void;
    const exited = new Promise<number | null>((r) => {
      resolveExit = r;
    });
    const handle: MockProcessHandle = {
      pid,
      exited,
      kill() {},
      stdout: null,
      stderr: null,
      resolveExit: (code) => resolveExit!(code),
    };
    this.handles.push(handle);
    return handle;
  }

  isAlive(): boolean {
    return false;
  }

  get lastHandle(): MockProcessHandle | undefined {
    return this.handles[this.handles.length - 1];
  }
}

describe("ChildProcessSupervisor", () => {
  let pm: MockProcessManager;
  let supervisor: ChildProcessSupervisor;

  beforeEach(() => {
    pm = new MockProcessManager();
    supervisor = new ChildProcessSupervisor({ processManager: pm });
  });

  it("creates a session and spawns a process", () => {
    const session = supervisor.createSession({ cwd: "/tmp" });
    expect(session.sessionId).toBeTruthy();
    expect(session.status).toBe("running");
    expect(session.pid).toBeDefined();
    expect(session.cwd).toBe("/tmp");
    expect(pm.spawnCalls).toHaveLength(1);
    expect(pm.spawnCalls[0].cwd).toBe("/tmp");
  });

  it("lists sessions", () => {
    supervisor.createSession({ cwd: "/a" });
    supervisor.createSession({ cwd: "/b" });
    expect(supervisor.listSessions()).toHaveLength(2);
  });

  it("gets a session by id", () => {
    const session = supervisor.createSession({ cwd: "/tmp" });
    expect(supervisor.getSession(session.sessionId)).toBe(session);
    expect(supervisor.getSession("nonexistent")).toBeUndefined();
  });

  it("stops a session", async () => {
    const session = supervisor.createSession({ cwd: "/tmp" });
    // Resolve exit so killProcess completes
    pm.lastHandle!.resolveExit(0);
    const result = await supervisor.stopSession(session.sessionId);
    expect(result).toBe(true);
    expect(session.status).toBe("stopped");
  });

  it("returns false when stopping nonexistent session", async () => {
    const result = await supervisor.stopSession("nonexistent");
    expect(result).toBe(false);
  });

  it("marks session as stopped when process exits", async () => {
    const session = supervisor.createSession({ cwd: "/tmp" });
    pm.lastHandle!.resolveExit(1);
    // Allow the exit handler to fire
    await new Promise((r) => setTimeout(r, 10));
    expect(session.status).toBe("stopped");
  });

  it("passes model and permissionMode as args", () => {
    supervisor.createSession({
      cwd: "/tmp",
      model: "opus",
      permissionMode: "plan",
    });
    const args = pm.spawnCalls[0].args;
    expect(args).toContain("--model");
    expect(args).toContain("opus");
    expect(args).toContain("--permission-mode");
    expect(args).toContain("plan");
  });

  it("reports session count", () => {
    expect(supervisor.sessionCount).toBe(0);
    supervisor.createSession({ cwd: "/a" });
    supervisor.createSession({ cwd: "/b" });
    expect(supervisor.sessionCount).toBe(2);
  });

  it("enforces maxSessions limit", () => {
    const limited = new ChildProcessSupervisor({
      processManager: pm,
      maxSessions: 2,
    });
    limited.createSession({ cwd: "/a" });
    limited.createSession({ cwd: "/b" });
    expect(() => limited.createSession({ cwd: "/c" })).toThrow("Maximum session limit reached (2)");
  });
});
