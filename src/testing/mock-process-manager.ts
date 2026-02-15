import type { ProcessHandle, ProcessManager, SpawnOptions } from "../interfaces/process-manager.js";

export interface MockProcessHandle extends ProcessHandle {
  /** Resolve the exited promise with an exit code */
  resolveExit: (code: number | null) => void;
  /** The kill calls made */
  killCalls: string[];
}

/**
 * Mock ProcessManager for testing.
 * Tracks spawned processes and allows controlling their lifecycle.
 */
export class MockProcessManager implements ProcessManager {
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
        resolveExit?.(code);
      },
      killCalls,
    };

    this.spawnedProcesses.push(handle);
    return handle;
  }

  isAlive(pid: number): boolean {
    return this.alivePids.has(pid);
  }

  /** Make the next spawn() call throw */
  failNextSpawn(): void {
    this._shouldFailSpawn = true;
  }

  /** Reset the fail flag */
  resetSpawnFailure(): void {
    this._shouldFailSpawn = false;
  }

  /** Get the last spawned process */
  get lastProcess(): MockProcessHandle | undefined {
    return this.spawnedProcesses[this.spawnedProcesses.length - 1];
  }

  /** Clear all tracking data */
  clear(): void {
    this.spawnCalls.length = 0;
    this.spawnedProcesses.length = 0;
    this.alivePids.clear();
    this._shouldFailSpawn = false;
  }
}
