/**
 * CodexAdapter — BackendAdapter for the Codex CLI's `app-server` WebSocket mode.
 *
 * Launches a codex app-server subprocess, connects via WebSocket,
 * performs the JSON-RPC initialize handshake, and returns a CodexSession.
 */

import WebSocket from "ws";
import type {
  BackendAdapter,
  BackendCapabilities,
  BackendSession,
  ConnectOptions,
} from "../../core/interfaces/backend-adapter.js";
import type { Logger } from "../../interfaces/logger.js";
import type { ProcessManager } from "../../interfaces/process-manager.js";
import { CodexLauncher } from "./codex-launcher.js";
import type { CodexInitResponse } from "./codex-message-translator.js";
import { CodexSession } from "./codex-session.js";

export interface CodexAdapterOptions {
  processManager: ProcessManager;
  logger?: Logger;
  /** Port for the codex app-server WebSocket. */
  port?: number;
  /** Path to the codex binary. */
  codexBinary?: string;
}

export class CodexAdapter implements BackendAdapter {
  readonly name = "codex" as const;

  readonly capabilities: BackendCapabilities = {
    streaming: true,
    permissions: true,
    slashCommands: false,
    availability: "local",
  };

  private readonly processManager: ProcessManager;
  private readonly logger?: Logger;
  private readonly port?: number;
  private readonly codexBinary?: string;

  constructor(options: CodexAdapterOptions) {
    this.processManager = options.processManager;
    this.logger = options.logger;
    this.port = options.port;
    this.codexBinary = options.codexBinary;
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

  private connectWebSocket(url: string): Promise<WebSocket> {
    return new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(url);

      const onOpen = () => {
        cleanup();
        resolve(ws);
      };

      const onError = (err: Error) => {
        cleanup();
        reject(new Error(`Failed to connect to codex app-server at ${url}: ${err.message}`));
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
        reject(new Error(`WebSocket error during handshake: ${err.message}`));
      };

      const cleanup = () => {
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
          params: { client: "beamcode" },
        }),
      );
    });
  }
}
