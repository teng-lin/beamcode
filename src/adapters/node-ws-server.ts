import type { WebSocket } from "ws";
import { WebSocketServer as WSServer } from "ws";
import type { AuthContext } from "../interfaces/auth.js";
import type { Logger } from "../interfaces/logger.js";
import type {
  OnCLIConnection,
  OnConsumerConnection,
  WebSocketServerLike,
} from "../interfaces/ws-server.js";
import type { OriginValidator } from "../server/origin-validator.js";
import { noopLogger } from "./noop-logger.js";

const CLI_PATH_RE = /^\/ws\/cli\/([^/]+)$/;
const CONSUMER_PATH_RE = /^\/ws\/consumer\/([^/]+)$/;
// UUID v4 validation pattern
const SESSION_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

function wrapSocket(ws: WebSocket): Parameters<OnCLIConnection>[0] {
  return {
    send: (data: string) => ws.send(data),
    close: (code?: number, reason?: string) => ws.close(code, reason),
    get bufferedAmount() {
      return ws.bufferedAmount;
    },
    on: ((event: string, handler: (...args: unknown[]) => void) => {
      ws.on(event, handler);
    }) as Parameters<OnCLIConnection>[0]["on"],
  };
}

export interface NodeWebSocketServerOptions {
  /** Port to listen on. Use 0 for a random free port. Ignored when `server` is provided. */
  port: number;
  /** Optional hostname to bind to. Defaults to "127.0.0.1" (localhost only). Ignored when `server` is provided. */
  host?: string;
  /** Optional origin validator to reject connections from untrusted origins. */
  originValidator?: OriginValidator;
  /** Maximum payload size in bytes (default: 1MB). */
  maxPayload?: number;
  /** Optional external HTTP server to attach to. When provided, WS piggybacks on this server instead of creating its own. */
  server?: import("http").Server;
  /** Optional logger instance. Defaults to noop. */
  logger?: Logger;
}

/**
 * Node.js WebSocket server adapter using the `ws` package.
 * Listens for CLI connections on `/ws/cli/:sessionId`.
 */
export class NodeWebSocketServer implements WebSocketServerLike {
  private wss: WSServer | null = null;
  private options: NodeWebSocketServerOptions;
  private logger: Logger;

  constructor(options: NodeWebSocketServerOptions) {
    this.options = options;
    this.logger = options.logger ?? noopLogger;
  }

  /** Actual port after listen (useful when constructed with port: 0). */
  get port(): number | undefined {
    const addr = this.wss?.address();
    if (addr && typeof addr === "object") return addr.port;
    // When attached to an external server, fall back to the HTTP server's address
    if (this.options.server) {
      const httpAddr = this.options.server.address();
      if (httpAddr && typeof httpAddr === "object") return httpAddr.port;
    }
    return undefined;
  }

  async listen(
    onCLIConnection: OnCLIConnection,
    onConsumerConnection?: OnConsumerConnection,
  ): Promise<void> {
    const { originValidator } = this.options;
    const verifyClient = originValidator
      ? (info: { origin: string; req: import("http").IncomingMessage }) => {
          const origin = info.origin || undefined;
          if (!originValidator.isAllowed(origin)) {
            this.logger.warn("Rejected WebSocket connection from untrusted origin", {
              origin: origin ?? "(none)",
            });
            return false;
          }
          return true;
        }
      : undefined;

    if (this.options.server) {
      // Attach to an external HTTP server — no standalone listen needed
      this.wss = new WSServer({
        server: this.options.server,
        maxPayload: this.options.maxPayload ?? 1_048_576,
        ...(verifyClient && { verifyClient }),
      });
      this.wireConnectionHandler(onCLIConnection, onConsumerConnection);
      return;
    }

    return new Promise((resolve, reject) => {
      this.wss = new WSServer({
        port: this.options.port,
        host: this.options.host ?? "127.0.0.1",
        maxPayload: this.options.maxPayload ?? 1_048_576,
        ...(verifyClient && { verifyClient }),
      });

      this.wss.on("listening", () => resolve());
      this.wss.on("error", (err) => reject(err));

      this.wireConnectionHandler(onCLIConnection, onConsumerConnection);
    });
  }

  private wireConnectionHandler(
    onCLIConnection: OnCLIConnection,
    onConsumerConnection?: OnConsumerConnection,
  ): void {
    if (!this.wss) return;

    this.wss.on("connection", (ws, req) => {
      const reqUrl = req.url ?? "";
      // Strip query string for path matching
      const pathOnly = reqUrl.split("?")[0];

      const cliMatch = pathOnly.match(CLI_PATH_RE);
      if (cliMatch) {
        const sessionId = decodeURIComponent(cliMatch[1]);
        // Validate session ID format (UUID)
        if (!SESSION_ID_PATTERN.test(sessionId)) {
          ws.close(1008, "Invalid session ID format");
          return;
        }
        onCLIConnection(wrapSocket(ws), sessionId);
        return;
      }

      const consumerMatch = pathOnly.match(CONSUMER_PATH_RE);
      if (consumerMatch && onConsumerConnection) {
        const sessionId = decodeURIComponent(consumerMatch[1]);
        // Validate session ID format (UUID)
        if (!SESSION_ID_PATTERN.test(sessionId)) {
          ws.close(1008, "Invalid session ID format");
          return;
        }
        const url = new URL(reqUrl, `http://${req.headers.host ?? "localhost"}`);
        const context: AuthContext = {
          sessionId,
          transport: {
            headers: { ...req.headers } as Record<string, string>,
            query: Object.fromEntries(url.searchParams),
            remoteAddress: req.socket.remoteAddress,
          },
        };
        onConsumerConnection(wrapSocket(ws), context);
        return;
      }

      ws.close(4000, "Invalid path");
    });
  }

  async close(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.wss) {
        resolve();
        return;
      }

      for (const client of this.wss.clients) {
        client.close(1001, "Server shutting down");
      }

      // When attached to an external server, only close the WSServer (caller manages the HTTP server)
      this.wss.close(() => {
        this.wss = null;
        resolve();
      });
    });
  }
}
