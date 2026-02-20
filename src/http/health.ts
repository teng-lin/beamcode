import type { IncomingMessage, ServerResponse } from "node:http";
import type { MetricsCollector } from "../interfaces/metrics.js";

export interface HealthContext {
  version: string;
  metrics: MetricsCollector;
}

export function handleHealth(
  _req: IncomingMessage,
  res: ServerResponse,
  ctx?: HealthContext,
): void {
  const body: Record<string, unknown> = { status: "ok" };
  if (ctx) {
    body.version = ctx.version;
    body.uptime_seconds = Math.floor(process.uptime());
    const stats = ctx.metrics.getStats?.();
    if (stats) {
      body.sessions = stats.totalSessions ?? 0;
      body.consumers = stats.totalConsumers ?? 0;
    }
    const errorStats = ctx.metrics.getErrorStats?.();
    if (errorStats) body.errors = errorStats.counts;
  }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
