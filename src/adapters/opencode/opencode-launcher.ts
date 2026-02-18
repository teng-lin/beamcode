/**
 * OpencodeLauncher — spawns and manages the `opencode serve` process.
 *
 * Extends ProcessSupervisor for kill escalation, circuit breaker,
 * PID tracking, and output piping.
 *
 * Detects server readiness via the "process:stdout" event (emitted by
 * ProcessSupervisor.pipeOutput) rather than reading stdout directly,
 * avoiding the ReadableStream single-reader lock conflict.
 */

import type { ProcessSupervisorOptions } from "../../core/process-supervisor.js";
import { ProcessSupervisor } from "../../core/process-supervisor.js";
import type { Logger } from "../../interfaces/logger.js";
import type { ProcessManager } from "../../interfaces/process-manager.js";

export interface OpencodeLauncherOptions {
  processManager: ProcessManager;
  logger?: Logger;
  killGracePeriodMs?: number;
}

export interface OpencodeLaunchOptions {
  port?: number;
  hostname?: string;
  cwd?: string;
  opencodeBinary?: string;
  password?: string;
}

/** Internal payload passed through spawnProcess to buildSpawnArgs. */
interface InternalSpawnPayload {
  binary: string;
  args: string[];
  cwd: string;
  env?: Record<string, string | undefined>;
}

export class OpencodeLauncher extends ProcessSupervisor {
  constructor(options: OpencodeLauncherOptions) {
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
   * Launch an opencode serve process.
   *
   * Spawns `opencode serve --port N --hostname H` and waits for the
   * "listening on" stdout output (detected via process:stdout events)
   * to confirm readiness.
   */
  async launch(
    sessionId: string,
    options: OpencodeLaunchOptions = {},
  ): Promise<{ url: string; pid: number }> {
    const port = options.port ?? 4096;
    const hostname = options.hostname ?? "127.0.0.1";
    const cwd = options.cwd ?? process.cwd();
    const binary = options.opencodeBinary ?? "opencode";
    const url = `http://${hostname}:${port}`;

    const args = ["serve", "--port", String(port), "--hostname", hostname];

    const env: Record<string, string | undefined> = {};
    if (options.password) {
      env.OPENCODE_SERVER_PASSWORD = options.password;
    }

    // Register a one-shot listener for "process:stdout" BEFORE spawning,
    // so we don't miss the ready line.
    const readyPromise = this.waitForReady(sessionId, url);

    const proc = this.spawnProcess(
      sessionId,
      { binary, args, cwd, env } satisfies InternalSpawnPayload,
      "opencode-launcher",
    );

    if (!proc) {
      throw new Error("Failed to spawn opencode serve process");
    }

    // Wait for the ready signal (with timeout)
    await readyPromise;

    return { url, pid: proc.pid };
  }

  private waitForReady(sessionId: string, _expectedUrl: string, timeoutMs = 15_000): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`opencode serve did not become ready within ${timeoutMs}ms`));
      }, timeoutMs);

      const handler = (event: { sessionId: string; data: string }) => {
        if (event.sessionId === sessionId && event.data.includes("listening on")) {
          cleanup();
          resolve();
        }
      };

      const cleanup = () => {
        clearTimeout(timer);
        this.off("process:stdout", handler);
      };

      this.on("process:stdout", handler);
    });
  }
}
