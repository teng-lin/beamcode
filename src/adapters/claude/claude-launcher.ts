import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { SessionLauncher } from "../../core/interfaces/session-launcher.js";
import type { RegisterSessionInput } from "../../core/interfaces/session-registry.js";
import type { ProcessSupervisorOptions } from "../../core/process-supervisor.js";
import { ProcessSupervisor } from "../../core/process-supervisor.js";
import type { Logger } from "../../interfaces/logger.js";
import type { ProcessManager, SpawnOptions } from "../../interfaces/process-manager.js";
import type { LauncherStateStorage } from "../../interfaces/storage.js";
import type { ProviderConfig, ResolvedConfig } from "../../types/config.js";
import { resolveConfig } from "../../types/config.js";
import type { LauncherEventMap } from "../../types/events.js";
import type { LaunchOptions, SessionInfo } from "../../types/session-state.js";
import { SlidingWindowBreaker } from "../sliding-window-breaker.js";

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

export interface ClaudeLauncherOptions {
  processManager: ProcessManager;
  config: ProviderConfig;
  storage?: LauncherStateStorage;
  logger?: Logger;
  /** Synchronous hook called just before spawning a CLI process. */
  beforeSpawn?: (sessionId: string, spawnOptions: SpawnOptions) => void;
}

/** Internal options passed through spawnProcess to buildSpawnArgs. */
interface InternalSpawnPayload {
  binary: string;
  args: string[];
  cwd: string;
  env?: Record<string, string | undefined>;
}

/**
 * Manages Claude Code CLI processes launched with --sdk-url.
 * Each session spawns a CLI that connects back to the provider's WebSocket server.
 *
 * Extends ProcessSupervisor for generic process management (kill escalation,
 * circuit breaker, PID tracking, output piping) and adds Claude-specific logic:
 * - --sdk-url, --resume, --print, --output-format argument construction
 * - CLI binary validation (prevent path traversal)
 * - Environment variable deny list enforcement
 * - Session state tracking (starting/connected/running/exited)
 */
export class ClaudeLauncher extends ProcessSupervisor<LauncherEventMap> implements SessionLauncher {
  private sessions = new Map<string, SessionInfo>();
  /** Track which sessions were launched with --resume (for resume failure detection). */
  private pendingResumes = new Map<string, string>();
  private storage: LauncherStateStorage | null;
  private config: ResolvedConfig;
  private beforeSpawnHook: ((sessionId: string, options: SpawnOptions) => void) | null;

  constructor(options: ClaudeLauncherOptions) {
    const config = resolveConfig(options.config);
    const cbConfig = config.cliRestartCircuitBreaker;

    const supervisorOptions: ProcessSupervisorOptions = {
      processManager: options.processManager,
      logger: options.logger,
      killGracePeriodMs: config.killGracePeriodMs,
      crashThresholdMs: config.resumeFailureThresholdMs,
      circuitBreaker: new SlidingWindowBreaker({
        failureThreshold: cbConfig.failureThreshold,
        windowMs: cbConfig.windowMs,
        recoveryTimeMs: cbConfig.recoveryTimeMs,
        successThreshold: cbConfig.successThreshold,
      }),
    };

    super(supervisorOptions);
    this.config = config;
    this.storage = options.storage ?? null;
    this.beforeSpawnHook = options.beforeSpawn ?? null;
  }

  // ---------------------------------------------------------------------------
  // ProcessSupervisor abstract implementation
  // ---------------------------------------------------------------------------

  protected buildSpawnArgs(
    _sessionId: string,
    options: unknown,
  ): { command: string; args: string[]; cwd: string; env?: Record<string, string | undefined> } {
    const payload = options as InternalSpawnPayload;
    return {
      command: payload.binary,
      args: payload.args,
      cwd: payload.cwd,
      env: payload.env,
    };
  }

  protected override onProcessExited(
    sessionId: string,
    exitCode: number | null,
    uptimeMs: number,
  ): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.state = "exited";
      session.exitCode = exitCode;

      // Detect resume failures: if the process exited almost immediately
      // after --resume, clear backendSessionId so the next relaunch starts fresh
      const resumeId = this.pendingResumes.get(sessionId);
      if (uptimeMs < this.config.resumeFailureThresholdMs && resumeId) {
        this.logger.error(
          `Session ${sessionId} exited immediately after --resume ` +
            `(${uptimeMs}ms). Clearing backendSessionId for fresh start.`,
        );
        session.backendSessionId = undefined;
        this.emit("process:resume_failed", { sessionId });
      }

      this.pendingResumes.delete(sessionId);
      this.persistState();
    }
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
    const data = this.storage.loadLauncherState<SessionInfo[]>();
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
  launch(options: LaunchOptions = {}): SessionInfo {
    // Enforce max concurrent sessions
    const activeSessions = Array.from(this.sessions.values()).filter((s) => s.state !== "exited");
    if (activeSessions.length >= this.config.maxConcurrentSessions) {
      throw new Error(
        `Maximum concurrent sessions (${this.config.maxConcurrentSessions}) reached. ` +
          `Kill or remove an existing session before launching a new one.`,
      );
    }

    const sessionId = randomUUID();
    const cwd = options.cwd || process.cwd();

    const info: SessionInfo = {
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
    if (!this.canRestart()) {
      this.logger.error(
        `Circuit breaker OPEN for CLI restarts: too many failures. Give the system time to recover.`,
      );
      return false;
    }

    // Kill old managed process if still alive
    const oldProc = this.getProcess(sessionId);
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
      this.removeProcess(sessionId);
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
      resumeSessionId: info.backendSessionId,
    });
    return true;
  }

  // ---------------------------------------------------------------------------
  // Spawn
  // ---------------------------------------------------------------------------

  private spawnCLI(
    sessionId: string,
    info: SessionInfo,
    options: LaunchOptions & { resumeSessionId?: string },
  ): void {
    let binary = options.claudeBinary || this.config.defaultClaudeBinary;

    // Validate binary name: allow absolute paths or simple basenames only
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

    // Resolve binary path via `which` if not absolute
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
      "--include-partial-messages",
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

    // Build environment, stripping denied env vars
    const mergedEnv: Record<string, string | undefined> = {
      ...process.env,
      ...options.env,
    };
    // Remove CLAUDECODE to avoid the nesting guard — we are intentionally
    // spawning claude, not running inside another Claude Code session.
    delete mergedEnv.CLAUDECODE;

    for (const key of this.config.envDenyList ?? []) {
      delete mergedEnv[key];
    }

    const spawnOptions: SpawnOptions = {
      command: binary,
      args,
      cwd: info.cwd,
      env: mergedEnv,
    };

    // Before-spawn hook -- allows host applications to inject guardrails, etc.
    if (this.beforeSpawnHook) {
      try {
        this.beforeSpawnHook(sessionId, spawnOptions);
      } catch (hookErr) {
        this.emitSpawnError(sessionId, info, "cli-launcher:beforeSpawn", toError(hookErr));
        return;
      }
    }

    // Track resume session ID for failure detection in onProcessExited
    if (options.resumeSessionId) {
      this.pendingResumes.set(sessionId, options.resumeSessionId);
    }

    // Delegate to ProcessSupervisor.spawnProcess, passing pre-built binary/args
    const proc = this.spawnProcess(
      sessionId,
      { binary, args, cwd: info.cwd, env: mergedEnv },
      "cli-launcher",
    );

    if (!proc) {
      // spawnProcess already emitted error and recorded circuit breaker failure
      info.state = "exited";
      info.exitCode = -1;
      this.pendingResumes.delete(sessionId);
      this.persistState();
      return;
    }

    info.pid = proc.pid;
    this.persistState();
  }

  /** Emit an error event and mark the session as exited due to a spawn failure. */
  private emitSpawnError(sessionId: string, info: SessionInfo, source: string, error: Error): void {
    this.emitError(sessionId, source, error);
    info.state = "exited";
    info.exitCode = -1;
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
   * Store the backend's internal session ID (from system.init message).
   * This is needed for --resume on relaunch.
   */
  setBackendSessionId(sessionId: string, backendSessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.backendSessionId = backendSessionId;
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
    const result = await this.killProcess(sessionId);

    const session = this.sessions.get(sessionId);
    if (session) {
      session.state = "exited";
      session.exitCode = -1;
    }
    this.persistState();
    return result;
  }

  /** Kill all active sessions. */
  async killAll(): Promise<void> {
    // Use the session-aware kill (not killAllProcesses) so session state is updated
    const ids = [...this.processes.keys()];
    await Promise.all(ids.map((id) => this.kill(id)));
  }

  /** Remove a session from internal maps (after kill or cleanup). */
  removeSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.removeProcess(sessionId);
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
  listSessions(): SessionInfo[] {
    return Array.from(this.sessions.values());
  }

  /** Get a specific session. */
  getSession(sessionId: string): SessionInfo | undefined {
    return this.sessions.get(sessionId);
  }

  /** Check if a session exists and is alive (not exited). */
  isAlive(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    return !!session && session.state !== "exited";
  }

  /** Get all sessions in "starting" state (awaiting CLI WebSocket connection). */
  getStartingSessions(): SessionInfo[] {
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

  /** Set the display name for a session. */
  setSessionName(sessionId: string, name: string): void {
    const info = this.sessions.get(sessionId);
    if (info) {
      info.name = name;
      this.persistState();
    }
  }

  /** Register a session entry (no process spawned). */
  register(info: RegisterSessionInput): SessionInfo {
    const entry: SessionInfo = {
      sessionId: info.sessionId,
      cwd: info.cwd,
      createdAt: info.createdAt,
      model: info.model,
      adapterName: info.adapterName,
      state: "starting",
    };
    this.sessions.set(info.sessionId, entry);
    this.persistState();
    return entry;
  }
}
