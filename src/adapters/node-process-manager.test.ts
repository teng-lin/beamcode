import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

const { mockSpawn, realSpawn } = vi.hoisted(() => {
  const mockSpawn = vi.fn();
  // We'll set realSpawn after import
  return { mockSpawn, realSpawn: { current: null as null | ((...args: unknown[]) => unknown) } };
});

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  realSpawn.current = original.spawn as (...args: unknown[]) => unknown;
  return {
    ...original,
    spawn: (...args: unknown[]) => {
      if (mockSpawn.getMockImplementation()) {
        return mockSpawn(...args);
      }
      return (original.spawn as Function)(...args);
    },
  };
});

import { NodeProcessManager } from "./node-process-manager.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("NodeProcessManager", () => {
  const manager = new NodeProcessManager();

  // -----------------------------------------------------------------------
  // spawn — real processes
  // -----------------------------------------------------------------------

  describe("spawn", () => {
    it("returns a ProcessHandle with pid, exited, kill, stdout, and stderr", () => {
      const handle = manager.spawn({
        command: "node",
        args: ["-e", "process.exit(0)"],
        cwd: "/tmp",
      });

      expect(typeof handle.pid).toBe("number");
      expect(handle.exited).toBeInstanceOf(Promise);
      expect(typeof handle.kill).toBe("function");
      expect(handle.stdout).not.toBeNull();
      expect(handle.stderr).not.toBeNull();
    });

    it("exited resolves with exit code on normal exit", async () => {
      const handle = manager.spawn({
        command: "node",
        args: ["-e", "process.exit(42)"],
        cwd: "/tmp",
      });

      const code = await handle.exited;
      expect(code).toBe(42);
    });

    it("exited resolves with 0 for successful process", async () => {
      const handle = manager.spawn({
        command: "node",
        args: ["-e", "process.exit(0)"],
        cwd: "/tmp",
      });

      const code = await handle.exited;
      expect(code).toBe(0);
    });

    it("exited resolves with null when killed by signal", async () => {
      const handle = manager.spawn({
        command: "node",
        args: ["-e", "setTimeout(() => {}, 30000)"],
        cwd: "/tmp",
      });

      // Poll until process is alive before sending signal
      await vi.waitFor(() => expect(manager.isAlive(handle.pid)).toBe(true), { timeout: 2000 });

      handle.kill("SIGKILL");

      const code = await handle.exited;
      expect(code).toBeNull();
    });

    it("kill sends the specified signal", async () => {
      const handle = manager.spawn({
        command: "node",
        args: ["-e", "setTimeout(() => {}, 30000)"],
        cwd: "/tmp",
      });

      await vi.waitFor(() => expect(manager.isAlive(handle.pid)).toBe(true), { timeout: 2000 });

      // Should not throw
      handle.kill("SIGTERM");

      const code = await handle.exited;
      expect(code).toBeNull();
    });

    it("kill defaults to SIGTERM", async () => {
      const handle = manager.spawn({
        command: "node",
        args: ["-e", "setTimeout(() => {}, 30000)"],
        cwd: "/tmp",
      });

      await vi.waitFor(() => expect(manager.isAlive(handle.pid)).toBe(true), { timeout: 2000 });

      // Call kill with no arguments (uses default SIGTERM)
      handle.kill();

      const code = await handle.exited;
      expect(code).toBeNull();
    });

    it("kill does not throw when process is already dead", async () => {
      const handle = manager.spawn({
        command: "node",
        args: ["-e", "process.exit(0)"],
        cwd: "/tmp",
      });

      await handle.exited;

      // Killing a dead process should not throw
      expect(() => handle.kill("SIGKILL")).not.toThrow();
    });

    it("captures stdout via ReadableStream", async () => {
      const handle = manager.spawn({
        command: "node",
        args: ["-e", 'process.stdout.write("hello world")'],
        cwd: "/tmp",
      });

      expect(handle.stdout).not.toBeNull();

      const reader = handle.stdout!.getReader();
      const chunks: Uint8Array[] = [];

      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }

      const output = new TextDecoder().decode(Buffer.concat(chunks));
      expect(output).toBe("hello world");

      await handle.exited;
    });
  });

  // -----------------------------------------------------------------------
  // spawn — undefined pid (mocked)
  // -----------------------------------------------------------------------

  describe("spawn with undefined pid", () => {
    it("throws when spawned process has no pid", () => {
      // Create a fake ChildProcess-like object with undefined pid
      const fakeChild = Object.assign(new EventEmitter(), {
        pid: undefined,
        stdin: null,
        stdout: null,
        stderr: null,
        stdio: [null, null, null, null, null] as const,
        channel: undefined,
        connected: false,
        exitCode: null,
        signalCode: null,
        spawnargs: [],
        spawnfile: "",
        killed: false,
        kill: vi.fn(),
        send: vi.fn(),
        disconnect: vi.fn(),
        unref: vi.fn(),
        ref: vi.fn(),
        [Symbol.dispose]: vi.fn(),
      });

      mockSpawn.mockImplementationOnce(() => fakeChild);

      expect(() =>
        manager.spawn({
          command: "bad-command",
          args: [],
          cwd: "/tmp",
        }),
      ).toThrow("Failed to spawn process: bad-command");

      mockSpawn.mockReset();
    });
  });

  // -----------------------------------------------------------------------
  // isAlive
  // -----------------------------------------------------------------------

  describe("isAlive", () => {
    it("returns true for the current process", () => {
      expect(manager.isAlive(process.pid)).toBe(true);
    });

    it("returns false for a non-existent PID", () => {
      // PID 999999 is extremely unlikely to exist
      expect(manager.isAlive(999999)).toBe(false);
    });

    it("returns true for a running child process", async () => {
      const handle = manager.spawn({
        command: "node",
        args: ["-e", "setTimeout(() => {}, 30000)"],
        cwd: "/tmp",
      });

      await vi.waitFor(() => expect(manager.isAlive(handle.pid)).toBe(true), { timeout: 2000 });

      handle.kill("SIGKILL");
      await handle.exited;
    });
  });
});
