import { describe, expect, it } from "vitest";
import { MockProcessManager } from "./mock-process-manager.js";

describe("MockProcessManager", () => {
  it("spawns a process and records the call", () => {
    const pm = new MockProcessManager();
    const opts = { command: "node", args: ["server.js"] };
    const handle = pm.spawn(opts);

    expect(pm.spawnCalls).toHaveLength(1);
    expect(pm.spawnCalls[0]).toBe(opts);
    expect(handle.pid).toBeGreaterThanOrEqual(10000);
    expect(handle.stdout).toBeNull();
    expect(handle.stderr).toBeNull();
  });

  it("assigns incrementing PIDs", () => {
    const pm = new MockProcessManager();
    const h1 = pm.spawn({ command: "a", args: [] });
    const h2 = pm.spawn({ command: "b", args: [] });

    expect(h2.pid).toBe(h1.pid + 1);
  });

  it("tracks spawned processes", () => {
    const pm = new MockProcessManager();
    pm.spawn({ command: "a", args: [] });
    pm.spawn({ command: "b", args: [] });

    expect(pm.spawnedProcesses).toHaveLength(2);
  });

  it("lastProcess returns the most recent handle", () => {
    const pm = new MockProcessManager();
    expect(pm.lastProcess).toBeUndefined();

    pm.spawn({ command: "a", args: [] });
    const h2 = pm.spawn({ command: "b", args: [] });

    expect(pm.lastProcess).toBe(h2);
  });

  it("isAlive returns true for spawned, false after exit", () => {
    const pm = new MockProcessManager();
    const handle = pm.spawn({ command: "node", args: [] });

    expect(pm.isAlive(handle.pid)).toBe(true);

    handle.resolveExit(0);
    expect(pm.isAlive(handle.pid)).toBe(false);
  });

  it("resolveExit resolves the exited promise", async () => {
    const pm = new MockProcessManager();
    const handle = pm.spawn({ command: "node", args: [] });

    handle.resolveExit(42);
    const code = await handle.exited;

    expect(code).toBe(42);
  });

  it("resolveExit is idempotent (second call ignored)", async () => {
    const pm = new MockProcessManager();
    const handle = pm.spawn({ command: "node", args: [] });

    handle.resolveExit(1);
    handle.resolveExit(2); // should be ignored
    const code = await handle.exited;

    expect(code).toBe(1);
  });

  it("kill records the signal and resolves exit", async () => {
    const pm = new MockProcessManager();
    const handle = pm.spawn({ command: "node", args: [] });

    handle.kill("SIGKILL");

    expect(handle.killCalls).toEqual(["SIGKILL"]);
    const code = await handle.exited;
    expect(code).toBeNull();
  });

  it("kill defaults to SIGTERM", () => {
    const pm = new MockProcessManager();
    const handle = pm.spawn({ command: "node", args: [] });

    handle.kill();
    expect(handle.killCalls).toEqual(["SIGTERM"]);
  });

  it("kill after exit still records signal but does not re-resolve", async () => {
    const pm = new MockProcessManager();
    const handle = pm.spawn({ command: "node", args: [] });

    handle.resolveExit(0);
    handle.kill("SIGKILL");

    expect(handle.killCalls).toEqual(["SIGKILL"]);
    const code = await handle.exited;
    expect(code).toBe(0);
  });

  it("failNextSpawn causes spawn to throw", () => {
    const pm = new MockProcessManager();
    pm.failNextSpawn();

    expect(() => pm.spawn({ command: "fail", args: [] })).toThrow("Mock spawn failure: fail");
  });

  it("resetSpawnFailure clears the failure flag", () => {
    const pm = new MockProcessManager();
    pm.failNextSpawn();
    pm.resetSpawnFailure();

    expect(() => pm.spawn({ command: "ok", args: [] })).not.toThrow();
  });

  it("clear resets all tracking data", () => {
    const pm = new MockProcessManager();
    pm.spawn({ command: "a", args: [] });
    pm.failNextSpawn();

    pm.clear();

    expect(pm.spawnCalls).toHaveLength(0);
    expect(pm.spawnedProcesses).toHaveLength(0);
    expect(pm.lastProcess).toBeUndefined();
    // failNextSpawn was also reset
    expect(() => pm.spawn({ command: "b", args: [] })).not.toThrow();
  });
});
