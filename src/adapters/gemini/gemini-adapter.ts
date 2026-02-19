/**
 * GeminiAdapter — BackendAdapter for the Gemini CLI's A2A server mode.
 *
 * Launches a gemini-cli-a2a-server subprocess, waits for the server to
 * start, performs a health check via the agent card endpoint, and returns
 * a GeminiSession.
 */

import type {
  BackendAdapter,
  BackendCapabilities,
  BackendSession,
  ConnectOptions,
} from "../../core/interfaces/backend-adapter.js";
import type { Logger } from "../../interfaces/logger.js";
import type { ProcessManager } from "../../interfaces/process-manager.js";
import { GeminiLauncher } from "./gemini-launcher.js";
import { GeminiSession } from "./gemini-session.js";

export interface GeminiAdapterOptions {
  processManager: ProcessManager;
  logger?: Logger;
  port?: number;
  geminiBinary?: string;
  healthCheckRetries?: number;
  healthCheckDelayMs?: number;
  fetchFn?: typeof fetch;
}

export class GeminiAdapter implements BackendAdapter {
  readonly name = "gemini" as const;

  readonly capabilities: BackendCapabilities = {
    streaming: true,
    permissions: true,
    slashCommands: false,
    availability: "local",
    teams: false,
  };

  private readonly processManager: ProcessManager;
  private readonly logger?: Logger;
  private readonly port?: number;
  private readonly geminiBinary?: string;
  private readonly healthCheckRetries: number;
  private readonly healthCheckDelayMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(options: GeminiAdapterOptions) {
    this.processManager = options.processManager;
    this.logger = options.logger;
    this.port = options.port;
    this.geminiBinary = options.geminiBinary;
    this.healthCheckRetries = options.healthCheckRetries ?? 30;
    this.healthCheckDelayMs = options.healthCheckDelayMs ?? 200;
    this.fetchFn = options.fetchFn ?? fetch;
  }

  async connect(options: ConnectOptions): Promise<BackendSession> {
    const adapterOptions = (options.adapterOptions ?? {}) as {
      cwd?: string;
      port?: number;
      geminiBinary?: string;
    };

    const launcher = new GeminiLauncher({
      processManager: this.processManager,
      logger: this.logger,
    });
    // Prevent Node's unhandled-error throw — spawn failures are also
    // surfaced via the thrown Error from launch().
    launcher.on("error", ({ source, error }) => {
      this.logger?.warn?.(`Launcher error [${source}]: ${error.message}`);
    });

    // 1. Launch gemini-cli-a2a-server
    const { baseUrl } = await launcher.launch(options.sessionId, {
      port: adapterOptions.port ?? this.port,
      cwd: adapterOptions.cwd,
      geminiBinary: adapterOptions.geminiBinary ?? this.geminiBinary,
    });

    // 2. Health check: GET /.well-known/agent-card.json
    try {
      await this.healthCheck(baseUrl);
    } catch (err) {
      // Clean up the launched process if health check fails
      await launcher.killProcess(options.sessionId);
      throw err;
    }

    // 3. Return session
    return new GeminiSession({
      sessionId: options.sessionId,
      baseUrl,
      launcher,
      logger: this.logger,
      fetchFn: this.fetchFn,
    });
  }

  private async healthCheck(baseUrl: string): Promise<void> {
    const url = `${baseUrl}/.well-known/agent-card.json`;
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.healthCheckRetries; attempt++) {
      try {
        const response = await this.fetchFn(url);
        if (response.ok) return;
        lastError = new Error(`Health check returned ${response.status}`);
      } catch (err) {
        lastError = err;
      }

      if (attempt < this.healthCheckRetries) {
        this.logger?.debug?.(
          `Gemini health check attempt ${attempt} failed, retrying in ${this.healthCheckDelayMs}ms`,
        );
        await new Promise((r) => setTimeout(r, this.healthCheckDelayMs));
      }
    }

    throw new Error(
      `Gemini A2A server health check failed after ${this.healthCheckRetries} attempts`,
      { cause: lastError },
    );
  }
}
