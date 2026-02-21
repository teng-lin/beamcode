import { createHash, timingSafeEqual } from "node:crypto";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { PrometheusMetricsCollector } from "../adapters/prometheus-metrics-collector.js";
import type { SessionCoordinator } from "../core/session-coordinator.js";
import { handleApiSessions } from "./api-sessions.js";
import { handleConsumerHtml } from "./consumer-html.js";
import { type HealthContext, handleHealth } from "./health.js";
import { handleMetrics } from "./metrics-endpoint.js";

export interface HttpServerOptions {
  sessionCoordinator: SessionCoordinator;
  activeSessionId: string;
  apiKey?: string;
  healthContext?: HealthContext;
  prometheusCollector?: PrometheusMetricsCollector;
}

/** Timing-safe string comparison using SHA-256 to normalize lengths. */
function timingSafeCompare(a: string, b: string): boolean {
  const hashA = createHash("sha256").update(a).digest();
  const hashB = createHash("sha256").update(b).digest();
  return timingSafeEqual(hashA, hashB);
}

export function createBeamcodeServer(
  options: HttpServerOptions,
): Server & { setActiveSessionId(id: string): void } {
  const { sessionCoordinator } = options;
  if (!sessionCoordinator) {
    throw new Error("createBeamcodeServer requires sessionCoordinator");
  }
  const { apiKey } = options;
  let { activeSessionId } = options;

  const server = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    // Security: API key gate for sensitive endpoints.
    // When configured, /api/*, /health, and /metrics require Authorization: Bearer <key>.
    // This prevents unauthenticated access both from LAN and through tunnels
    // (cloudflared forwards requests as localhost, making IP-based checks unreliable).
    const isProtected =
      url.pathname.startsWith("/api/") || url.pathname === "/health" || url.pathname === "/metrics";
    if (apiKey && isProtected) {
      const auth = req.headers.authorization ?? "";
      if (!timingSafeCompare(auth, `Bearer ${apiKey}`)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }
    }

    // Route dispatch
    if (url.pathname === "/health") {
      handleHealth(req, res, options.healthContext);
      return;
    }

    if (url.pathname === "/metrics" && options.prometheusCollector) {
      handleMetrics(req, res, options.prometheusCollector);
      return;
    }

    if (url.pathname.startsWith("/api/sessions")) {
      handleApiSessions(req, res, url, sessionCoordinator);
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
