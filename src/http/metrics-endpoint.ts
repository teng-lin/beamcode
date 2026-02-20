import type { IncomingMessage, ServerResponse } from "node:http";
import type { PrometheusMetricsCollector } from "../adapters/prometheus-metrics-collector.js";

export async function handleMetrics(
  _req: IncomingMessage,
  res: ServerResponse,
  collector: PrometheusMetricsCollector,
): Promise<void> {
  const output = await collector.getMetricsOutput();
  res.writeHead(200, {
    "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
  });
  res.end(output);
}
