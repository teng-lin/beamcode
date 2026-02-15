import type { WebSocket } from "ws";
import { WebSocketServer as WSServer } from "ws";
import type { AuthContext } from "../interfaces/auth.js";
import type {
  OnCLIConnection,
  OnConsumerConnection,
  WebSocketServerLike,
} from "../interfaces/ws-server.js";

const CLI_PATH_RE = /^\/ws\/cli\/([^/]+)$/;
const CONSUMER_PATH_RE = /^\/ws\/consumer\/([^/]+)$/;
// UUID v4 validation pattern
const SESSION_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

function wrapSocket(ws: WebSocket): Parameters<OnCLIConnection>[0] {
  return {
    send: (data: string) => ws.send(data),
    close: (code?: number, reason?: string) => ws.close(code, reason),
    on: ((event: string, handler: (...args: unknown[]) => void) => {
      ws.on(event, handler);
    }) as Parameters<OnCLIConnection>[0]["on"],
  };
}

export interface NodeWebSocketServerOptions {
  /** Port to listen on. Use 0 for a random free port. */
  port: number;
  /** Optional hostname to bind to. Defaults to "127.0.0.1" (localhost only). */
  host?: string;
}

/**
 * Node.js WebSocket server adapter using the `ws` package.
 * Listens for CLI connections on `/ws/cli/:sessionId`.
 */
export class NodeWebSocketServer implements WebSocketServerLike {
  private wss: WSServer | null = null;
  private options: NodeWebSocketServerOptions;

  constructor(options: NodeWebSocketServerOptions) {
    this.options = options;
  }

  /** Actual port after listen (useful when constructed with port: 0). */
  get port(): number | undefined {
    const addr = this.wss?.address();
    if (addr && typeof addr === "object") return addr.port;
    return undefined;
  }

  async listen(
    onCLIConnection: OnCLIConnection,
    onConsumerConnection?: OnConsumerConnection,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      this.wss = new WSServer({
        port: this.options.port,
        host: this.options.host ?? "127.0.0.1",
      });

      this.wss.on("listening", () => resolve());
      this.wss.on("error", (err) => reject(err));

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

      this.wss.close(() => {
        this.wss = null;
        resolve();
      });
    });
  }
}
