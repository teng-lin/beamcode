import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { NoopLogger } from "../adapters/noop-logger.js";
import { SlidingWindowBreaker } from "../adapters/sliding-window-breaker.js";
import type { CircuitBreaker } from "../interfaces/circuit-breaker.js";
import type { Logger } from "../interfaces/logger.js";
import type { ProcessHandle, ProcessManager, SpawnOptions } from "../interfaces/process-manager.js";
import type { LauncherStateStorage } from "../interfaces/storage.js";
import type { ProviderConfig, ResolvedConfig } from "../types/config.js";
import { resolveConfig } from "../types/config.js";
import type { LauncherEventMap } from "../types/events.js";
import type { LaunchOptions, SdkSessionInfo } from "../types/session-state.js";
import { TypedEventEmitter } from "./typed-emitter.js";

/**
 * Regex to validate CLI binary names before passing to execFileSync.
 * Only allows basenames (no slashes) to prevent path traversal.
 * Absolute paths are allowed separately via the startsWith("/") check.
 */
const SAFE_BASENAME_PATTERN = /^[a-zA-Z0-9_.-]+$/;
const SAFE_ABSOLUTE_PATH_PATTERN = /^\/[a-zA-Z0-9_./-]+$/;

/** Coerce an unknown thrown value into an Error instance. */
function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

export interface CLILauncherOptions {
  processManager: ProcessManager;
  config: ProviderConfig;
  storage?: LauncherStateStorage;
  logger?: Logger;
  /** Synchronous hook called just before spawning a CLI process. */
  beforeSpawn?: (sessionId: string, spawnOptions: SpawnOptions) => void;
}

/**
 * Manages Claude Code CLI processes launched with --sdk-url.
 * Each session spawns a CLI that connects back to the provider's WebSocket server.
 *
 * This is a runtime-agnostic port of the Vibe Companion's CliLauncher.
 * It uses an injected ProcessManager instead of Bun.spawn, emits typed events
 * instead of using callbacks, and supports configurable limits/timeouts.
 */
export class CLILauncher extends TypedEventEmitter<LauncherEventMap> {
  private sessions = new Map<string, SdkSessionInfo>();
  private processes = new Map<string, ProcessHandle>();
  private processManager: ProcessManager;
  private storage: LauncherStateStorage | null;
  private logger: Logger;
  private config: ResolvedConfig;
  private beforeSpawnHook: ((sessionId: string, options: SpawnOptions) => void) | null;
  private restartCircuitBreaker: CircuitBreaker; // Fail-fast for repeated crashes

  constructor(options: CLILauncherOptions) {
    super();
    this.processManager = options.processManager;
    this.config = resolveConfig(options.config);
    this.storage = options.storage ?? null;
    this.logger = options.logger ?? new NoopLogger();
    this.beforeSpawnHook = options.beforeSpawn ?? null;

    // Initialize circuit breaker for CLI restart resilience
    const cbConfig = this.config.cliRestartCircuitBreaker ?? {
      failureThreshold: 5,
      windowMs: 60000,
      recoveryTimeMs: 30000,
      successThreshold: 2,
    };
    this.restartCircuitBreaker = new SlidingWindowBreaker({
      failureThreshold: cbConfig.failureThreshold,
      windowMs: cbConfig.windowMs,
      recoveryTimeMs: cbConfig.recoveryTimeMs,
      successThreshold: cbConfig.successThreshold,
    });
  }

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------

  /** Persist launcher state to storage. */
  private persistState(): void {
    if (!this.storage) return;
    const data = Array.from(this.sessions.values());
    this.storage.saveLauncherState(data);
  }

  /**
   * Restore sessions from storage and check which PIDs are still alive.
   * Returns the number of recovered (still-running) sessions.
   */
  restoreFromStorage(): number {
    if (!this.storage) return 0;
    const data = this.storage.loadLauncherState<SdkSessionInfo[]>();
    if (!data || !Array.isArray(data)) return 0;

    let recovered = 0;
    for (const info of data) {
      if (this.sessions.has(info.sessionId)) continue;

      if (info.pid && info.state !== "exited") {
        if (this.processManager.isAlive(info.pid)) {
          // Process is alive but WS not yet re-established
          info.state = "starting";
          this.sessions.set(info.sessionId, info);
          recovered++;
        } else {
          info.state = "exited";
          info.exitCode = -1;
          this.sessions.set(info.sessionId, info);
        }
      } else {
        this.sessions.set(info.sessionId, info);
      }
    }

    if (recovered > 0) {
      this.logger.info(`Recovered ${recovered} live session(s) from storage`);
    }
    return recovered;
  }

  // ---------------------------------------------------------------------------
  // Launch / Relaunch
  // ---------------------------------------------------------------------------

  /**
   * Launch a new Claude Code CLI session.
   * Throws if maxConcurrentSessions would be exceeded.
   */
  launch(options: LaunchOptions = {}): SdkSessionInfo {
    // Enforce max concurrent sessions (P3)
    const activeSessions = Array.from(this.sessions.values()).filter((s) => s.state !== "exited");
    if (activeSessions.length >= this.config.maxConcurrentSessions) {
      throw new Error(
        `Maximum concurrent sessions (${this.config.maxConcurrentSessions}) reached. ` +
          `Kill or remove an existing session before launching a new one.`,
      );
    }

    const sessionId = randomUUID();
    const cwd = options.cwd || process.cwd();

    const info: SdkSessionInfo = {
      sessionId,
      state: "starting",
      model: options.model,
      permissionMode: options.permissionMode,
      cwd,
      createdAt: Date.now(),
    };

    this.sessions.set(sessionId, info);
    this.spawnCLI(sessionId, info, options);
    return info;
  }

  /**
   * Relaunch a CLI process for an existing session.
   * Kills the old process if still alive, then spawns a fresh CLI
   * that connects back using --resume with the CLI's internal session ID.
   */
  async relaunch(sessionId: string): Promise<boolean> {
    const info = this.sessions.get(sessionId);
    if (!info) return false;

    // Circuit breaker: check if we should attempt restart
    if (!this.restartCircuitBreaker.canExecute()) {
      this.logger.error(
        `Circuit breaker OPEN for CLI restarts: too many failures. Give the system time to recover.`,
      );
      return false;
    }

    // Kill old managed process if still alive
    const oldProc = this.processes.get(sessionId);
    if (oldProc) {
      try {
        oldProc.kill("SIGTERM");
        await Promise.race([
          oldProc.exited,
          new Promise((r) => setTimeout(r, this.config.relaunchGracePeriodMs)),
        ]);
      } catch {
        // ignore
      }
      this.processes.delete(sessionId);
    } else if (info.pid) {
      // Process from a previous server instance -- kill by PID check
      try {
        process.kill(info.pid, "SIGTERM");
      } catch {
        // already dead
      }
    }

    info.state = "starting";
    this.spawnCLI(sessionId, info, {
      model: info.model,
      permissionMode: info.permissionMode,
      cwd: info.cwd,
      resumeSessionId: info.cliSessionId,
    });
    return true;
  }

  // ---------------------------------------------------------------------------
  // Spawn
  // ---------------------------------------------------------------------------

  private spawnCLI(
    sessionId: string,
    info: SdkSessionInfo,
    options: LaunchOptions & { resumeSessionId?: string },
  ): void {
    let binary = options.claudeBinary || this.config.defaultClaudeBinary;

    // Validate binary name (S1): allow absolute paths or simple basenames only
    const isAbsolute = SAFE_ABSOLUTE_PATH_PATTERN.test(binary);
    const isBasename = SAFE_BASENAME_PATTERN.test(binary);
    if (!isAbsolute && !isBasename) {
      this.emitSpawnError(
        sessionId,
        info,
        "cli-launcher",
        new Error(
          `Invalid CLI binary name: "${binary}". Must be a simple name (no slashes) or an absolute path.`,
        ),
      );
      return;
    }

    // Resolve binary path via `which` if not absolute (S1 -- use execFileSync)
    if (!isAbsolute) {
      try {
        binary = execFileSync("which", [binary], {
          encoding: "utf-8",
        }).trim();
      } catch {
        // Fall through; hope it's in PATH
      }
    }

    // Build SDK WebSocket URL
    const sdkUrl = this.config.cliWebSocketUrlTemplate
      ? this.config.cliWebSocketUrlTemplate(sessionId)
      : `ws://localhost:${this.config.port}/ws/cli/${sessionId}`;

    // Build args
    const args: string[] = [
      "--sdk-url",
      sdkUrl,
      "--print",
      "--output-format",
      "stream-json",
      "--input-format",
      "stream-json",
      "--verbose",
    ];

    if (options.model) {
      args.push("--model", options.model);
    }
    if (options.permissionMode) {
      args.push("--permission-mode", options.permissionMode);
    }
    if (options.allowedTools) {
      for (const tool of options.allowedTools) {
        args.push("--allowedTools", tool);
      }
    }

    // When relaunching, pass --resume to restore conversation context
    if (options.resumeSessionId) {
      args.push("--resume", options.resumeSessionId);
    }
    // Always pass -p "" for headless mode
    args.push("-p", "");

    // Build environment, stripping denied env vars (S6)
    const mergedEnv: Record<string, string | undefined> = {
      ...process.env,
      CLAUDECODE: "1",
      ...options.env,
    };

    for (const key of this.config.envDenyList ?? []) {
      delete mergedEnv[key];
    }

    const spawnOptions: SpawnOptions = {
      command: binary,
      args,
      cwd: info.cwd,
      env: mergedEnv,
    };

    // Before-spawn hook (M1) -- allows host applications to inject guardrails, etc.
    if (this.beforeSpawnHook) {
      try {
        this.beforeSpawnHook(sessionId, spawnOptions);
      } catch (hookErr) {
        this.emitSpawnError(sessionId, info, "cli-launcher:beforeSpawn", toError(hookErr));
        return;
      }
    }

    this.logger.info(`Spawning session ${sessionId}: ${binary} ${args.join(" ")}`);

    let proc: ProcessHandle;
    try {
      proc = this.processManager.spawn(spawnOptions);
    } catch (spawnErr) {
      this.emitSpawnError(sessionId, info, "cli-launcher:spawn", toError(spawnErr));
      return;
    }

    info.pid = proc.pid;
    this.processes.set(sessionId, proc);

    this.emit("process:spawned", { sessionId, pid: proc.pid });

    // Stream stdout/stderr and emit events
    this.pipeOutput(sessionId, proc);

    // Monitor process exit
    const spawnedAt = Date.now();
    proc.exited.then((exitCode) => {
      const uptimeMs = Date.now() - spawnedAt;
      this.logger.info(`Session ${sessionId} exited (code=${exitCode}, uptime=${uptimeMs}ms)`);

      const session = this.sessions.get(sessionId);
      if (session) {
        session.state = "exited";
        session.exitCode = exitCode;

        // Circuit breaker: record failure if process exited quickly (likely a crash)
        if (uptimeMs < this.config.resumeFailureThresholdMs) {
          this.restartCircuitBreaker.recordFailure();
          this.logger.warn(
            `CLI process failed quickly (${uptimeMs}ms). Circuit breaker state: ${this.restartCircuitBreaker.getState()}`,
          );
        } else {
          // Process ran for a reasonable time, consider it a success
          this.restartCircuitBreaker.recordSuccess();
        }

        // Detect resume failures: if the process exited almost immediately
        // after --resume, clear cliSessionId so the next relaunch starts fresh
        if (uptimeMs < this.config.resumeFailureThresholdMs && options.resumeSessionId) {
          this.logger.error(
            `Session ${sessionId} exited immediately after --resume ` +
              `(${uptimeMs}ms). Clearing cliSessionId for fresh start.`,
          );
          session.cliSessionId = undefined;
          this.emit("process:resume_failed", { sessionId });
        }
      }

      this.processes.delete(sessionId);
      this.persistState();
      this.emit("process:exited", { sessionId, exitCode, uptimeMs });
    });

    this.persistState();
  }

  /** Emit an error event and mark the session as exited due to a spawn failure. */
  private emitSpawnError(
    sessionId: string,
    info: SdkSessionInfo,
    source: string,
    error: Error,
  ): void {
    this.emit("error", { source, error, sessionId });
    info.state = "exited";
    info.exitCode = -1;
    // Record spawn failure in circuit breaker
    this.restartCircuitBreaker.recordFailure();
    this.persistState();
  }

  // ---------------------------------------------------------------------------
  // Session state mutations
  // ---------------------------------------------------------------------------

  /**
   * Mark a session as connected (called when CLI establishes WebSocket connection).
   */
  markConnected(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session && (session.state === "starting" || session.state === "connected")) {
      session.state = "connected";
      // Record success in circuit breaker
      this.restartCircuitBreaker.recordSuccess();
      this.logger.info(`Session ${sessionId} connected via WebSocket`);
      this.persistState();
      this.emit("process:connected", { sessionId });
    }
  }

  /**
   * Store the CLI's internal session ID (from system.init message).
   * This is needed for --resume on relaunch.
   */
  setCLISessionId(sessionId: string, cliSessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.cliSessionId = cliSessionId;
      this.persistState();
    }
  }

  // ---------------------------------------------------------------------------
  // Kill / Cleanup
  // ---------------------------------------------------------------------------

  /**
   * Kill a session's CLI process.
   * Sends SIGTERM first, then SIGKILL after killGracePeriodMs.
   */
  async kill(sessionId: string): Promise<boolean> {
    const proc = this.processes.get(sessionId);
    if (!proc) return false;

    proc.kill("SIGTERM");

    const exited = await Promise.race([
      proc.exited.then(() => true),
      new Promise<false>((resolve) =>
        setTimeout(() => resolve(false), this.config.killGracePeriodMs),
      ),
    ]);

    if (!exited) {
      this.logger.info(`Force-killing session ${sessionId}`);
      proc.kill("SIGKILL");
    }

    const session = this.sessions.get(sessionId);
    if (session) {
      session.state = "exited";
      session.exitCode = -1;
    }
    this.processes.delete(sessionId);
    this.persistState();
    return true;
  }

  /** Kill all active sessions. */
  async killAll(): Promise<void> {
    const ids = [...this.processes.keys()];
    await Promise.all(ids.map((id) => this.kill(id)));
  }

  /** Remove a session from internal maps (after kill or cleanup). */
  removeSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.processes.delete(sessionId);
    this.persistState();
  }

  /** Remove all exited sessions. Returns the number pruned. */
  pruneExited(): number {
    let pruned = 0;
    for (const [id, session] of this.sessions) {
      if (session.state === "exited") {
        this.sessions.delete(id);
        pruned++;
      }
    }
    if (pruned > 0) {
      this.persistState();
    }
    return pruned;
  }

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  /** List all sessions (active + recently exited). */
  listSessions(): SdkSessionInfo[] {
    return Array.from(this.sessions.values());
  }

  /** Get a specific session. */
  getSession(sessionId: string): SdkSessionInfo | undefined {
    return this.sessions.get(sessionId);
  }

  /** Check if a session exists and is alive (not exited). */
  isAlive(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    return !!session && session.state !== "exited";
  }

  /** Get all sessions in "starting" state (awaiting CLI WebSocket connection). */
  getStartingSessions(): SdkSessionInfo[] {
    return Array.from(this.sessions.values()).filter((s) => s.state === "starting");
  }

  /** Set the archived flag on a session. */
  setArchived(sessionId: string, archived: boolean): void {
    const info = this.sessions.get(sessionId);
    if (info) {
      info.archived = archived;
      this.persistState();
    }
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
}
