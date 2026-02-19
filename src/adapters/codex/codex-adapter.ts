/**
 * CodexAdapter — BackendAdapter for the Codex CLI's `app-server` WebSocket mode.
 *
 * Launches a codex app-server subprocess, connects via WebSocket,
 * performs the JSON-RPC initialize handshake, and returns a CodexSession.
 */

import WebSocket from "ws";
import type {
  AdapterSlashExecutor,
  BackendAdapter,
  BackendCapabilities,
  BackendSession,
  ConnectOptions,
} from "../../core/interfaces/backend-adapter.js";
import type { Logger } from "../../interfaces/logger.js";
import type { ProcessManager } from "../../interfaces/process-manager.js";
import { resolvePackageVersion } from "../../utils/resolve-package-version.js";
import { CodexLauncher } from "./codex-launcher.js";
import type { CodexInitResponse } from "./codex-message-translator.js";
import { CodexSession } from "./codex-session.js";
import { CodexSlashExecutor } from "./codex-slash-executor.js";

const version = resolvePackageVersion(import.meta.url, [
  "../../../package.json",
  "../../../../package.json",
  "../../package.json",
]);

export interface CodexAdapterOptions {
  processManager: ProcessManager;
  logger?: Logger;
  /** Port for the codex app-server WebSocket. */
  port?: number;
  /** Path to the codex binary. */
  codexBinary?: string;
  /** Max WebSocket connection attempts (default: 20). */
  connectRetries?: number;
  /** Base delay between retries in ms (default: 100). */
  connectRetryDelayMs?: number;
}

export class CodexAdapter implements BackendAdapter {
  readonly name = "codex" as const;

  readonly capabilities: BackendCapabilities = {
    streaming: true,
    permissions: true,
    slashCommands: true,
    availability: "local",
    teams: false,
  };

  private readonly processManager: ProcessManager;
  private readonly logger?: Logger;
  private readonly port?: number;
  private readonly codexBinary?: string;
  private readonly connectRetries: number;
  private readonly connectRetryDelayMs: number;

  constructor(options: CodexAdapterOptions) {
    this.processManager = options.processManager;
    this.logger = options.logger;
    this.port = options.port;
    this.codexBinary = options.codexBinary;
    this.connectRetries = options.connectRetries ?? 20;
    this.connectRetryDelayMs = options.connectRetryDelayMs ?? 100;
  }

  async connect(options: ConnectOptions): Promise<BackendSession> {
    const adapterOptions = (options.adapterOptions ?? {}) as {
      cwd?: string;
      port?: number;
      codexBinary?: string;
    };

    const launcher = new CodexLauncher({
      processManager: this.processManager,
      logger: this.logger,
    });
    // Prevent Node's unhandled-error throw — spawn failures are also
    // surfaced via the thrown Error from launch().
    launcher.on("error", ({ source, error }) => {
      this.logger?.warn?.(`Launcher error [${source}]: ${error.message}`);
    });

    // 1. Launch codex app-server
    const { url } = await launcher.launch(options.sessionId, {
      port: adapterOptions.port ?? this.port,
      cwd: adapterOptions.cwd,
      codexBinary: adapterOptions.codexBinary ?? this.codexBinary,
    });

    // 2. Connect WebSocket
    const ws = await this.connectWebSocket(url);

    // 3. Initialize handshake
    const initResponse = await this.performHandshake(ws);

    // 4. Return session
    return new CodexSession({
      sessionId: options.sessionId,
      ws,
      launcher,
      initResponse,
    });
  }

  createSlashExecutor(session: BackendSession): AdapterSlashExecutor | null {
    if (session instanceof CodexSession) {
      return new CodexSlashExecutor(session);
    }
    return null;
  }

  private async connectWebSocket(url: string): Promise<WebSocket> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.connectRetries; attempt++) {
      try {
        return await this.tryConnect(url);
      } catch (err) {
        lastError = err;
        if (attempt < this.connectRetries) {
          const delay = Math.min(this.connectRetryDelayMs * attempt, 1000);
          this.logger?.debug?.(
            `Codex WS connect attempt ${attempt} failed, retrying in ${delay}ms`,
          );
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }

    throw new Error(
      `Failed to connect to codex app-server at ${url} after ${this.connectRetries} attempts`,
      { cause: lastError },
    );
  }

  private tryConnect(url: string): Promise<WebSocket> {
    return new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(url, { perMessageDeflate: false });

      const onOpen = () => {
        cleanup();
        resolve(ws);
      };

      const onError = (err: Error) => {
        cleanup();
        ws.terminate();
        reject(err);
      };

      const cleanup = () => {
        ws.removeListener("open", onOpen);
        ws.removeListener("error", onError);
      };

      ws.on("open", onOpen);
      ws.on("error", onError);
    });
  }

  private performHandshake(ws: WebSocket): Promise<CodexInitResponse> {
    return new Promise<CodexInitResponse>((resolve, reject) => {
      const rpcId = 1;
      const HANDSHAKE_TIMEOUT_MS = 10_000;

      const timer = setTimeout(() => {
        cleanup();
        ws.terminate();
        reject(new Error("Initialize handshake timed out"));
      }, HANDSHAKE_TIMEOUT_MS);

      const onMessage = (data: WebSocket.RawData) => {
        try {
          const msg = JSON.parse(data.toString()) as {
            id?: number;
            result?: CodexInitResponse;
            error?: { message: string };
          };
          if (msg.id === rpcId) {
            cleanup();
            if (msg.error) {
              ws.terminate();
              reject(new Error(`Initialize handshake failed: ${msg.error.message}`));
              return;
            }
            const initResponse = (msg.result ?? { capabilities: {} }) as CodexInitResponse;

            // Send initialized notification (handshake complete)
            ws.send(JSON.stringify({ jsonrpc: "2.0", method: "initialized" }));
            resolve(initResponse);
          }
        } catch {
          // Ignore parse errors during handshake
        }
      };

      const onError = (err: Error) => {
        cleanup();
        ws.terminate();
        reject(new Error(`WebSocket error during handshake`, { cause: err }));
      };

      const cleanup = () => {
        clearTimeout(timer);
        ws.removeListener("message", onMessage);
        ws.removeListener("error", onError);
      };

      ws.on("message", onMessage);
      ws.on("error", onError);

      // Send initialize request
      ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: rpcId,
          method: "initialize",
          params: {
            clientInfo: { name: "beamcode", version },
          },
        }),
      );
    });
  }
}
