/**
 * GeminiLauncher — spawns and manages the `gemini-cli-a2a-server` process.
 *
 * Extends ProcessSupervisor for kill escalation, circuit breaker,
 * PID tracking, and output piping.
 */

import type { ProcessSupervisorOptions } from "../../core/process-supervisor.js";
import { ProcessSupervisor } from "../../core/process-supervisor.js";
import type { Logger } from "../../interfaces/logger.js";
import type { ProcessManager } from "../../interfaces/process-manager.js";

export interface GeminiLauncherOptions {
  processManager: ProcessManager;
  logger?: Logger;
  killGracePeriodMs?: number;
}

export interface GeminiLaunchOptions {
  /** Port for the A2A server (0 for auto-assign). */
  port?: number;
  /** Working directory for the gemini process. */
  cwd?: string;
  /** Path to the gemini binary (defaults to "gemini-cli-a2a-server"). */
  geminiBinary?: string;
}

interface InternalSpawnPayload {
  binary: string;
  args: string[];
  cwd: string;
  env: Record<string, string | undefined>;
}

export class GeminiLauncher extends ProcessSupervisor {
  constructor(options: GeminiLauncherOptions) {
    const supervisorOptions: ProcessSupervisorOptions = {
      processManager: options.processManager,
      logger: options.logger,
      killGracePeriodMs: options.killGracePeriodMs ?? 5000,
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
      env: payload.env,
    };
  }

  /**
   * Launch a gemini-cli-a2a-server process.
   *
   * Spawns the server and monitors stdout for the "Agent Server started on
   * http://localhost:{port}" message to discover the base URL.
   */
  async launch(
    sessionId: string,
    options: GeminiLaunchOptions = {},
  ): Promise<{ baseUrl: string; pid: number }> {
    const port = options.port ?? 0;
    const cwd = options.cwd ?? process.cwd();
    const binary = options.geminiBinary ?? "gemini-cli-a2a-server";

    // Inherit parent environment so the child has PATH, HOME, API keys, etc.
    // CODER_AGENT_PORT is the env var gemini-cli-a2a-server reads for its listen port.
    const env: Record<string, string | undefined> = {
      ...process.env,
      CODER_AGENT_PORT: String(port),
    };

    const proc = this.spawnProcess(
      sessionId,
      { binary, args: [], cwd, env } satisfies InternalSpawnPayload,
      "gemini-launcher",
    );

    if (!proc) {
      throw new Error("Failed to spawn gemini-cli-a2a-server process");
    }

    // Wait for the server to log its listening URL on stdout
    const baseUrl = await this.waitForServerUrl(sessionId, proc.pid);

    return { baseUrl, pid: proc.pid };
  }

  private waitForServerUrl(sessionId: string, pid: number): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const STARTUP_TIMEOUT_MS = 30_000;

      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("Gemini A2A server startup timed out"));
      }, STARTUP_TIMEOUT_MS);

      const onStdout = (event: { sessionId: string; data: string }) => {
        if (event.sessionId !== sessionId) return;
        const match = event.data.match(/Agent Server started on (https?:\/\/[^\s]+)/);
        if (match) {
          cleanup();
          resolve(match[1]);
        }
      };

      const onExit = (event: { sessionId: string; exitCode: number | null }) => {
        if (event.sessionId !== sessionId) return;
        cleanup();
        reject(
          new Error(`Gemini A2A server exited during startup (code=${event.exitCode}, pid=${pid})`),
        );
      };

      const cleanup = () => {
        clearTimeout(timer);
        this.off("process:stdout", onStdout);
        this.off("process:exited", onExit);
      };

      this.on("process:stdout", onStdout);
      this.on("process:exited", onExit);
    });
  }
}
