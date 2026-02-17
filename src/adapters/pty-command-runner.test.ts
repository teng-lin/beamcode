import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PtyCommandRunner } from "./pty-command-runner.js";

// ─── Mock factory ───────────────────────────────────────────────────────────

function createMockPty() {
  let dataCallback: ((data: string) => void) | null = null;
  let exitCallback: ((e: { exitCode: number; signal?: number }) => void) | null = null;

  const pty = {
    onData: vi.fn((cb: (data: string) => void) => {
      dataCallback = cb;
      return { dispose: vi.fn() };
    }),
    onExit: vi.fn((cb: (e: { exitCode: number; signal?: number }) => void) => {
      exitCallback = cb;
      return { dispose: vi.fn() };
    }),
    write: vi.fn(),
    kill: vi.fn(),
    pid: 12345,
  };

  const spawn = vi.fn(() => pty);

  return {
    pty,
    spawn,
    emitData(data: string) {
      dataCallback!(data);
    },
    emitExit(exitCode: number) {
      exitCallback!({ exitCode });
    },
  };
}

function createRunner(mock: ReturnType<typeof createMockPty>) {
  const runner = new PtyCommandRunner();
  (runner as any).loadNodePty = vi.fn(async () => ({ spawn: mock.spawn }));
  return runner;
}

function defaultOptions() {
  return {
    cwd: "/test",
    timeoutMs: 10000,
    silenceThresholdMs: 500,
  };
}

/** Flush the microtask queue so async operations can complete. */
const flushMicrotasks = () => new Promise<void>((resolve) => queueMicrotask(resolve));

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("PtyCommandRunner", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("loadNodePty", () => {
    it("throws descriptive error when node-pty not installed", async () => {
      const runner = new PtyCommandRunner();
      (runner as any).loadNodePty = vi.fn(async () => {
        throw new Error("node-pty is required for PTY-based slash commands but is not installed.");
      });

      await expect(runner.execute("cli-1", "/help", defaultOptions())).rejects.toThrow(
        "node-pty is required",
      );
    });
  });

  describe("trust prompt handling", () => {
    it("sends Enter when trust prompt detected", async () => {
      const mock = createMockPty();
      const runner = createRunner(mock);
      const promise = runner.execute("cli-1", "/help", defaultOptions());

      // Flush so loadNodePty resolves and callbacks are set
      await flushMicrotasks();

      mock.emitData("Is this a project you created or one you trust? [Yes/No]");
      vi.advanceTimersByTime(600);

      expect(mock.pty.write).toHaveBeenCalledWith("\r");

      mock.emitExit(0);
      const result = await promise;
      expect(result.exitCode).toBe(0);
    });

    it("sends Enter when bypass confirm detected", async () => {
      const mock = createMockPty();
      const runner = createRunner(mock);
      const promise = runner.execute("cli-1", "/help", defaultOptions());
      await flushMicrotasks();

      mock.emitData("Enter to confirm: Bypass Permissions for this project");
      vi.advanceTimersByTime(600);

      expect(mock.pty.write).toHaveBeenCalledWith("\r");

      mock.emitExit(0);
      await promise;
    });
  });

  describe("command execution", () => {
    it("types command after startup silence, then sends Enter", async () => {
      const mock = createMockPty();
      const runner = createRunner(mock);
      const promise = runner.execute("cli-1", "/help", defaultOptions());
      await flushMicrotasks();

      mock.emitData("Loading...");
      // Advance past TUI_READY_SILENCE_MS (3000ms)
      vi.advanceTimersByTime(3100);

      expect(mock.pty.write).toHaveBeenCalledWith("/help");

      // Advance past COMMAND_ENTER_DELAY_MS (300ms)
      vi.advanceTimersByTime(400);
      expect(mock.pty.write).toHaveBeenCalledWith("\r");

      // Simulate command output
      mock.emitData("Help content here");
      vi.advanceTimersByTime(600);

      const result = await promise;
      expect(result.output).toBe("Help content here");
    });

    it("process exits during command → resolves with exitCode", async () => {
      const mock = createMockPty();
      const runner = createRunner(mock);
      const promise = runner.execute("cli-1", "/help", defaultOptions());
      await flushMicrotasks();

      // Skip to command-sent phase
      mock.emitData("startup");
      vi.advanceTimersByTime(3500);
      mock.emitData("some output");

      mock.emitExit(42);
      const result = await promise;
      expect(result.exitCode).toBe(42);
    });

    it("hard timeout fires → rejects with timeout error", async () => {
      const mock = createMockPty();
      const runner = createRunner(mock);
      const promise = runner.execute("cli-1", "/help", {
        ...defaultOptions(),
        timeoutMs: 1000,
      });
      await flushMicrotasks();

      vi.advanceTimersByTime(1100);

      await expect(promise).rejects.toThrow("PTY command timed out");
    });
  });

  describe("output handling", () => {
    it("strips ANSI codes from output", async () => {
      const mock = createMockPty();
      const runner = createRunner(mock);
      const promise = runner.execute("cli-1", "/help", defaultOptions());
      await flushMicrotasks();

      // Skip to command-sent phase
      mock.emitData("startup");
      vi.advanceTimersByTime(3500);

      mock.emitData("\x1b[32mGreen text\x1b[0m");
      vi.advanceTimersByTime(600);

      const result = await promise;
      expect(result.output).toBe("Green text");
    });

    it("preserves raw output separately", async () => {
      const mock = createMockPty();
      const runner = createRunner(mock);
      const promise = runner.execute("cli-1", "/help", defaultOptions());
      await flushMicrotasks();

      mock.emitData("startup");
      vi.advanceTimersByTime(3500);
      mock.emitData("\x1b[32mGreen text\x1b[0m");
      vi.advanceTimersByTime(600);

      const result = await promise;
      expect(result.rawOutput).toBe("\x1b[32mGreen text\x1b[0m");
    });
  });

  describe("cleanup", () => {
    it("dispose() is a no-op (no throw)", () => {
      const runner = new PtyCommandRunner();
      expect(() => runner.dispose()).not.toThrow();
    });

    it("process killed on settle", async () => {
      const mock = createMockPty();
      const runner = createRunner(mock);
      const promise = runner.execute("cli-1", "/help", defaultOptions());
      await flushMicrotasks();

      mock.emitExit(0);
      await promise;

      expect(mock.pty.kill).toHaveBeenCalled();
    });
  });
});
