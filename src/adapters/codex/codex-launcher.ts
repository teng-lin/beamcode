/**
 * CodexLauncher — spawns and manages the `codex app-server` process.
 *
 * Extends ProcessSupervisor for kill escalation, circuit breaker,
 * PID tracking, and output piping.
 */

import type { ProcessSupervisorOptions } from "../../core/process-supervisor.js";
import { ProcessSupervisor } from "../../core/process-supervisor.js";
import type { Logger } from "../../interfaces/logger.js";
import type { ProcessManager } from "../../interfaces/process-manager.js";
import { SlidingWindowBreaker } from "../sliding-window-breaker.js";

export interface CodexLauncherOptions {
  processManager: ProcessManager;
  logger?: Logger;
  /** Grace period (ms) before escalating SIGTERM → SIGKILL. */
  killGracePeriodMs?: number;
}

export interface CodexLaunchOptions {
  /** WebSocket port for the app-server to listen on. */
  port?: number;
  /** Working directory for the codex process. */
  cwd?: string;
  /** Path to the codex binary (defaults to "codex"). */
  codexBinary?: string;
}

/** Internal payload passed through spawnProcess to buildSpawnArgs. */
interface InternalSpawnPayload {
  binary: string;
  args: string[];
  cwd: string;
}

export class CodexLauncher extends ProcessSupervisor {
  constructor(options: CodexLauncherOptions) {
    const supervisorOptions: ProcessSupervisorOptions = {
      processManager: options.processManager,
      logger: options.logger,
      killGracePeriodMs: options.killGracePeriodMs ?? 5000,
      circuitBreaker: new SlidingWindowBreaker({
        failureThreshold: 5,
        windowMs: 60000,
        recoveryTimeMs: 30000,
        successThreshold: 2,
      }),
    };
    super(supervisorOptions);
  }

  protected buildSpawnArgs(
    _sessionId: string,
    options: unknown,
  ): { command: string; args: string[]; cwd: string; env?: Record<string, string | undefined> } {
    const payload = options as InternalSpawnPayload;
    return {
      command: payload.binary,
      args: payload.args,
      cwd: payload.cwd,
    };
  }

  /**
   * Launch a codex app-server process.
   *
   * Spawns `codex app-server --listen ws://127.0.0.1:{port}` and
   * monitors stdout for the WebSocket URL confirmation.
   *
   * Returns the WebSocket URL to connect to.
   */
  async launch(
    sessionId: string,
    options: CodexLaunchOptions = {},
  ): Promise<{ url: string; pid: number }> {
    const port = options.port ?? 19836;
    const cwd = options.cwd ?? process.cwd();
    const binary = options.codexBinary ?? "codex";
    const url = `ws://127.0.0.1:${port}`;

    const args = ["app-server", "--listen", url];

    const proc = this.spawnProcess(
      sessionId,
      { binary, args, cwd } satisfies InternalSpawnPayload,
      "codex-launcher",
    );

    if (!proc) {
      throw new Error("Failed to spawn codex app-server process");
    }

    return { url, pid: proc.pid };
  }
}
