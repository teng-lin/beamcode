import type { ProcessHandle, ProcessManager, SpawnOptions } from "../interfaces/process-manager.js";

/**
 * MockProcessManager simulates the ProcessManager interface for testing.
 *
 * This mock is designed for e2e tests where actual CLI processes aren't available
 * (like in CI environments). It simulates process lifecycle behavior without spawning
 * real processes.
 *
 * Key behaviors:
 * - Spawns processes with mock PIDs (10000+)
 * - Tracks process lifecycle (alive/dead)
 * - Simulates process exits via resolveExit()
 * - Records kill signals for test assertions
 * - No actual stdout/stderr (returns null streams)
 */
export class MockProcessManager implements ProcessManager {
  readonly spawnCalls: SpawnOptions[] = [];
  readonly spawnedProcesses: MockProcessHandle[] = [];

  private alivePids = new Set<number>();
  private nextPid = 10000;
  private _shouldFailSpawn = false;

  spawn(options: SpawnOptions): ProcessHandle {
    // Record the spawn call for test assertions
    this.spawnCalls.push(options);

    if (this._shouldFailSpawn) {
      throw new Error(`Mock spawn failure: ${options.command}`);
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
        // Auto-resolve exit when killed (simulates real process behavior)
        // Use null exit code to indicate killed by signal
        if (!handle._hasExited) {
          handle._hasExited = true;
          resolveExit?.(null);
        }
      },
      // Mock processes don't have real stdout/stderr
      stdout: null,
      stderr: null,
      // Test control methods
      resolveExit: (code: number | null) => {
        if (!handle._hasExited) {
          handle._hasExited = true;
          this.alivePids.delete(pid);
          resolveExit?.(code);
        }
      },
      killCalls,
      _hasExited: false,
    };

    this.spawnedProcesses.push(handle);
    return handle;
  }

  isAlive(pid: number): boolean {
    return this.alivePids.has(pid);
  }

  /**
   * Make the next spawn() call throw an error.
   * Useful for testing error handling paths.
   */
  failNextSpawn(): void {
    this._shouldFailSpawn = true;
  }

  /**
   * Reset the spawn failure flag.
   */
  resetSpawnFailure(): void {
    this._shouldFailSpawn = false;
  }

  /**
   * Get the most recently spawned process.
   */
  get lastProcess(): MockProcessHandle | undefined {
    return this.spawnedProcesses[this.spawnedProcesses.length - 1];
  }

  /**
   * Clear all tracking data. Useful for test cleanup.
   */
  clear(): void {
    this.spawnCalls.length = 0;
    this.spawnedProcesses.length = 0;
    this.alivePids.clear();
    this._shouldFailSpawn = false;
  }
}

/**
 * Extended ProcessHandle interface with test control methods.
 */
export interface MockProcessHandle extends ProcessHandle {
  /** Manually resolve the exited promise with an exit code */
  resolveExit: (code: number | null) => void;
  /** Array of kill signals that have been called on this process */
  killCalls: string[];
  /** Internal flag tracking if process has exited */
  _hasExited: boolean;
}
