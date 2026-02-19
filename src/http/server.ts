import { createHash, timingSafeEqual } from "node:crypto";
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
  apiKey?: string;
}

export function createBeamcodeServer(
  options: HttpServerOptions,
): Server & { setActiveSessionId(id: string): void } {
  const { sessionManager, apiKey } = options;
  let { activeSessionId } = options;

  const server = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    // Security: API key gate for /api/* endpoints.
    // When configured, all /api requests must include Authorization: Bearer <key>.
    // This prevents unauthenticated access both from LAN and through tunnels
    // (cloudflared forwards requests as localhost, making IP-based checks unreliable).
    if (apiKey && url.pathname.startsWith("/api/")) {
      const auth = req.headers.authorization;
      const expected = `Bearer ${apiKey}`;
      const a = createHash("sha256")
        .update(auth ?? "")
        .digest();
      const b = createHash("sha256").update(expected).digest();
      if (!timingSafeEqual(a, b)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized" }));
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
