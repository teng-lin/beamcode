import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { SessionManager } from "../core/session-manager.js";
import { handleApiSessions } from "./api-sessions.js";
import { handleConsumerHtml } from "./consumer-html.js";
import { handleHealth } from "./health.js";

export interface HttpServerOptions {
  sessionManager: SessionManager;
  activeSessionId: string;
  isTunnelActive?: boolean | (() => boolean);
}

export function createBeamcodeServer(
  options: HttpServerOptions,
): Server & { setActiveSessionId(id: string): void } {
  const { sessionManager, isTunnelActive } = options;
  let { activeSessionId } = options;

  const server = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    // Restrict /api/* to localhost when tunnel is active
    const tunnelActive = typeof isTunnelActive === "function" ? isTunnelActive() : isTunnelActive;
    if (tunnelActive && url.pathname.startsWith("/api/")) {
      const remote = req.socket.remoteAddress;
      const isLocal = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
      if (!isLocal) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "API access restricted to localhost" }));
        return;
      }
    }

    // Route dispatch
    if (url.pathname === "/health") {
      handleHealth(req, res);
      return;
    }

    if (url.pathname.startsWith("/api/sessions")) {
      handleApiSessions(req, res, url, sessionManager);
      return;
    }

    // Redirect bare / to /?session=<id> so the consumer connects automatically
    if (url.pathname === "/" && !url.searchParams.has("session") && activeSessionId) {
      res.writeHead(302, { Location: `/?session=${activeSessionId}` });
      res.end();
      return;
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      handleConsumerHtml(req, res);
      return;
    }

    res.writeHead(404);
    res.end("Not Found");
  });

  return Object.assign(server, {
    setActiveSessionId(id: string) {
      activeSessionId = id;
    },
  });
}
