/** A handle to a spawned process — abstracts Bun.Subprocess and Node ChildProcess. */
export interface ProcessHandle {
  readonly pid: number;
  /** Resolves when process exits. Null exit code means killed by signal. */
  readonly exited: Promise<number | null>;
  kill(signal?: "SIGTERM" | "SIGKILL" | "SIGINT"): void;
  readonly stdout: ReadableStream<Uint8Array> | null;
  readonly stderr: ReadableStream<Uint8Array> | null;
}

export interface SpawnOptions {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string | undefined>;
}

export interface ProcessManager {
  spawn(options: SpawnOptions): ProcessHandle;
  /** Check if a PID is alive (signal 0). */
  isAlive(pid: number): boolean;
}
