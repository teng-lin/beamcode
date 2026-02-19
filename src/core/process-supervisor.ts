import { noopLogger } from "../adapters/noop-logger.js";
import { toBeamCodeError } from "../errors.js";
import type { CircuitBreaker } from "../interfaces/circuit-breaker.js";
import type { Logger } from "../interfaces/logger.js";
import type { ProcessHandle, ProcessManager } from "../interfaces/process-manager.js";
import { TypedEventEmitter } from "./typed-emitter.js";

/** Circuit breaker snapshot included in process:exited when breaker is not CLOSED. */
export interface BreakerSnapshot {
  state: string;
  failureCount: number;
  recoveryTimeRemainingMs: number;
}

/** Minimum event map that any ProcessSupervisor must support. */
export interface SupervisorEventMap {
  "process:spawned": { sessionId: string; pid: number };
  "process:exited": {
    sessionId: string;
    exitCode: number | null;
    uptimeMs: number;
    circuitBreaker?: BreakerSnapshot;
  };
  "process:stdout": { sessionId: string; data: string };
  "process:stderr": { sessionId: string; data: string };
  error: { source: string; error: Error; sessionId?: string };
}

/** Noop circuit breaker used when no breaker is injected. */
const NOOP_BREAKER: CircuitBreaker = {
  canExecute: () => true,
  recordSuccess: () => {},
  recordFailure: () => {},
  getState: () => "closed",
};

export interface ProcessSupervisorOptions {
  processManager: ProcessManager;
  logger?: Logger;
  /** Grace period (ms) before escalating SIGTERM to SIGKILL. */
  killGracePeriodMs?: number;
  /** Pre-constructed circuit breaker instance for restart resilience. */
  circuitBreaker?: CircuitBreaker;
  /** Threshold (ms): if a process exits faster than this, it counts as a crash. */
  crashThresholdMs?: number;
}

/**
 * Abstract base class for managing spawned child processes.
 *
 * Provides:
 * - Kill escalation: SIGTERM -> wait -> SIGKILL
 * - Circuit breaker integration for restart resilience
 * - PID tracking per session
 * - Output piping with event emission
 *
 * Subclasses implement `buildSpawnArgs` to define command/args/env.
 */
export abstract class ProcessSupervisor<
  TEventMap extends SupervisorEventMap = SupervisorEventMap,
> extends TypedEventEmitter<TEventMap> {
  protected readonly processes = new Map<string, ProcessHandle>();
  protected readonly processManager: ProcessManager;
  protected readonly logger: Logger;
  protected readonly restartCircuitBreaker: CircuitBreaker;
  protected readonly killGracePeriodMs: number;
  protected readonly crashThresholdMs: number;

  constructor(options: ProcessSupervisorOptions) {
    super();
    this.processManager = options.processManager;
    this.logger = options.logger ?? noopLogger;
    this.killGracePeriodMs = options.killGracePeriodMs ?? 5000;
    this.crashThresholdMs = options.crashThresholdMs ?? 5000;
    this.restartCircuitBreaker = options.circuitBreaker ?? NOOP_BREAKER;
  }

  /** Build the spawn command, args, cwd, and env for a session. */
  protected abstract buildSpawnArgs(
    sessionId: string,
    options: unknown,
  ): { command: string; args: string[]; cwd: string; env?: Record<string, string | undefined> };

  /** Called after a process exits. Subclasses can override for custom bookkeeping. */
  protected onProcessExited(_sessionId: string, _exitCode: number | null, _uptimeMs: number): void {
    // Default: no-op. Subclasses override.
  }

  /** Whether the circuit breaker allows a new spawn/restart. */
  canRestart(): boolean {
    return this.restartCircuitBreaker.canExecute();
  }

  /**
   * Spawn a process for the given session.
   * Returns the ProcessHandle, or null if spawn failed (error emitted).
   * @param errorSourcePrefix - prefix for error event source (default: "supervisor")
   */
  protected spawnProcess(
    sessionId: string,
    options: unknown,
    errorSourcePrefix = "supervisor",
  ): ProcessHandle | null {
    let spawnArgs: ReturnType<ProcessSupervisor["buildSpawnArgs"]>;
    try {
      spawnArgs = this.buildSpawnArgs(sessionId, options);
    } catch (err) {
      this.emitError(sessionId, `${errorSourcePrefix}:buildSpawnArgs`, toBeamCodeError(err));
      return null;
    }

    this.logger.info("Spawning session process", {
      sessionId,
      command: spawnArgs.command,
      args: spawnArgs.args.join(" "),
    });

    let proc: ProcessHandle;
    try {
      proc = this.processManager.spawn(spawnArgs);
    } catch (spawnErr) {
      this.emitError(sessionId, `${errorSourcePrefix}:spawn`, toBeamCodeError(spawnErr));
      return null;
    }

    this.processes.set(sessionId, proc);
    // Cast needed because TEventMap may extend SupervisorEventMap
    this.emit("process:spawned", { sessionId, pid: proc.pid });

    this.pipeOutput(sessionId, proc);
    this.monitorExit(sessionId, proc);

    return proc;
  }

  /** Emit an error event and record the failure in the circuit breaker. */
  protected emitError(sessionId: string, source: string, error: Error): void {
    this.emit("error", { source, error, sessionId });
    this.restartCircuitBreaker.recordFailure();
  }

  /**
   * Kill a session's process.
   * Sends SIGTERM first, then SIGKILL after killGracePeriodMs.
   * Returns true if a process was found and killed.
   */
  async killProcess(sessionId: string): Promise<boolean> {
    const proc = this.processes.get(sessionId);
    if (!proc) return false;

    proc.kill("SIGTERM");

    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const exited = await Promise.race([
      proc.exited.then(() => true),
      new Promise<false>((resolve) => {
        killTimer = setTimeout(() => resolve(false), this.killGracePeriodMs);
      }),
    ]);
    if (killTimer !== undefined) clearTimeout(killTimer);

    if (!exited) {
      this.logger.info("Force-killing session", { sessionId });
      proc.kill("SIGKILL");
    }

    this.processes.delete(sessionId);
    return true;
  }

  /** Kill all tracked processes. */
  async killAllProcesses(): Promise<void> {
    const ids = [...this.processes.keys()];
    await Promise.all(ids.map((id) => this.killProcess(id)));
  }

  /** Check if a managed process handle exists for a session. */
  hasProcess(sessionId: string): boolean {
    return this.processes.has(sessionId);
  }

  /** Get the PID of a managed process. */
  getPid(sessionId: string): number | undefined {
    return this.processes.get(sessionId)?.pid;
  }

  /** Remove a process handle without killing (e.g. after it exits on its own). */
  protected removeProcess(sessionId: string): void {
    this.processes.delete(sessionId);
  }

  /** Get the managed ProcessHandle for a session (for subclass use). */
  protected getProcess(sessionId: string): ProcessHandle | undefined {
    return this.processes.get(sessionId);
  }

  // ---------------------------------------------------------------------------
  // Output piping
  // ---------------------------------------------------------------------------

  private pipeOutput(sessionId: string, proc: ProcessHandle): void {
    if (proc.stdout) {
      this.pipeStream(sessionId, proc.stdout, "process:stdout");
    }
    if (proc.stderr) {
      this.pipeStream(sessionId, proc.stderr, "process:stderr");
    }
  }

  private async pipeStream(
    sessionId: string,
    stream: ReadableStream<Uint8Array>,
    eventName: "process:stdout" | "process:stderr",
  ): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        if (text.trim()) {
          this.emit(eventName, { sessionId, data: text });
        }
      }
    } catch {
      // Stream closed or errored -- expected on process exit
    } finally {
      reader.releaseLock();
    }
  }

  // ---------------------------------------------------------------------------
  // Exit monitoring
  // ---------------------------------------------------------------------------

  private monitorExit(sessionId: string, proc: ProcessHandle): void {
    const spawnedAt = Date.now();
    proc.exited.then((exitCode) => {
      const uptimeMs = Date.now() - spawnedAt;
      this.logger.info("Session exited", { sessionId, exitCode, uptimeMs });

      if (uptimeMs < this.crashThresholdMs) {
        this.restartCircuitBreaker.recordFailure();
        this.logger.warn("Process failed quickly", {
          sessionId,
          uptimeMs,
          circuitBreakerState: this.restartCircuitBreaker.getState(),
        });
      } else {
        this.restartCircuitBreaker.recordSuccess();
      }

      this.processes.delete(sessionId);
      this.onProcessExited(sessionId, exitCode, uptimeMs);

      // Include circuit breaker snapshot when breaker is not CLOSED
      const breakerState = this.restartCircuitBreaker.getState();
      const circuitBreaker =
        breakerState !== "closed" && this.restartCircuitBreaker.getSnapshot
          ? this.restartCircuitBreaker.getSnapshot()
          : undefined;

      this.emit("process:exited", { sessionId, exitCode, uptimeMs, circuitBreaker });
    });
  }
}
