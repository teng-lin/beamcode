import type { MetricsCollector, MetricsEventType } from "../interfaces/metrics.js";

type PromClient = typeof import("prom-client");

/**
 * Prometheus-backed MetricsCollector using a private registry.
 * Requires prom-client to be passed in at construction time.
 */
export class PrometheusMetricsCollector implements MetricsCollector {
  private readonly registry: InstanceType<PromClient["Registry"]>;

  // Counters
  private readonly sessionsCreatedTotal: InstanceType<PromClient["Counter"]>;
  private readonly messagesReceivedTotal: InstanceType<PromClient["Counter"]>;
  private readonly messagesSentTotal: InstanceType<PromClient["Counter"]>;
  private readonly messagesDroppedTotal: InstanceType<PromClient["Counter"]>;
  private readonly errorsTotal: InstanceType<PromClient["Counter"]>;
  private readonly authFailuresTotal: InstanceType<PromClient["Counter"]>;
  private readonly sendFailuresTotal: InstanceType<PromClient["Counter"]>;
  private readonly rateLimitExceededTotal: InstanceType<PromClient["Counter"]>;

  // Gauges
  private readonly sessionsActive: InstanceType<PromClient["Gauge"]>;
  private readonly consumersActive: InstanceType<PromClient["Gauge"]>;
  private readonly backendsActive: InstanceType<PromClient["Gauge"]>;
  private readonly queueDepth: InstanceType<PromClient["Gauge"]>;

  // Histograms
  private readonly operationDuration: InstanceType<PromClient["Histogram"]>;

  constructor(
    promClient: PromClient,
    options?: { prefix?: string; defaultLabels?: Record<string, string> },
  ) {
    const prefix = options?.prefix ?? "beamcode_";
    this.registry = new promClient.Registry();

    if (options?.defaultLabels) {
      this.registry.setDefaultLabels(options.defaultLabels);
    }

    // Counters
    this.sessionsCreatedTotal = new promClient.Counter({
      name: `${prefix}sessions_created_total`,
      help: "Total number of sessions created",
      registers: [this.registry],
    });

    this.messagesReceivedTotal = new promClient.Counter({
      name: `${prefix}messages_received_total`,
      help: "Total messages received",
      labelNames: ["source"],
      registers: [this.registry],
    });

    this.messagesSentTotal = new promClient.Counter({
      name: `${prefix}messages_sent_total`,
      help: "Total messages sent",
      labelNames: ["target"],
      registers: [this.registry],
    });

    this.messagesDroppedTotal = new promClient.Counter({
      name: `${prefix}messages_dropped_total`,
      help: "Total messages dropped",
      registers: [this.registry],
    });

    this.errorsTotal = new promClient.Counter({
      name: `${prefix}errors_total`,
      help: "Total errors recorded",
      labelNames: ["severity", "source"],
      registers: [this.registry],
    });

    this.authFailuresTotal = new promClient.Counter({
      name: `${prefix}auth_failures_total`,
      help: "Total authentication failures",
      registers: [this.registry],
    });

    this.sendFailuresTotal = new promClient.Counter({
      name: `${prefix}send_failures_total`,
      help: "Total send failures",
      labelNames: ["target"],
      registers: [this.registry],
    });

    this.rateLimitExceededTotal = new promClient.Counter({
      name: `${prefix}ratelimit_exceeded_total`,
      help: "Total rate limit exceeded events",
      labelNames: ["source"],
      registers: [this.registry],
    });

    // Gauges
    this.sessionsActive = new promClient.Gauge({
      name: `${prefix}sessions_active`,
      help: "Number of currently active sessions",
      registers: [this.registry],
    });

    this.consumersActive = new promClient.Gauge({
      name: `${prefix}consumers_active`,
      help: "Number of currently connected consumers",
      registers: [this.registry],
    });

    this.backendsActive = new promClient.Gauge({
      name: `${prefix}backends_active`,
      help: "Number of currently connected backends",
      registers: [this.registry],
    });

    this.queueDepth = new promClient.Gauge({
      name: `${prefix}queue_depth`,
      help: "Current queue depth",
      labelNames: ["queue_type"],
      registers: [this.registry],
    });

    // Histograms
    this.operationDuration = new promClient.Histogram({
      name: `${prefix}operation_duration_seconds`,
      help: "Duration of operations in seconds",
      labelNames: ["operation"],
      buckets: [0.01, 0.05, 0.1, 0.5, 1, 5],
      registers: [this.registry],
    });
  }

  recordEvent(event: MetricsEventType): void {
    switch (event.type) {
      case "session:created":
        this.sessionsCreatedTotal.inc();
        this.sessionsActive.inc();
        break;
      case "session:closed":
        this.sessionsActive.dec();
        break;
      case "consumer:connected":
        this.consumersActive.inc();
        break;
      case "consumer:disconnected":
        this.consumersActive.dec();
        break;
      case "backend:connected":
        this.backendsActive.inc();
        break;
      case "backend:disconnected":
        this.backendsActive.dec();
        break;
      case "message:received":
        this.messagesReceivedTotal.inc({ source: event.source });
        break;
      case "message:sent":
        this.messagesSentTotal.inc({ target: event.target });
        break;
      case "message:dropped":
        this.messagesDroppedTotal.inc();
        break;
      case "error":
        this.errorsTotal.inc({ severity: event.severity, source: event.source });
        break;
      case "auth:failed":
        this.authFailuresTotal.inc();
        break;
      case "send:failed":
        this.sendFailuresTotal.inc({ target: event.target });
        break;
      case "ratelimit:exceeded":
        this.rateLimitExceededTotal.inc({ source: event.source });
        break;
      case "latency":
        this.operationDuration.observe({ operation: event.operation }, event.durationMs / 1000);
        break;
      case "queue:depth":
        this.queueDepth.set({ queue_type: event.queueType }, event.depth);
        break;
    }
  }

  async getMetricsOutput(): Promise<string> {
    return this.registry.metrics();
  }

  reset(): void {
    this.registry.resetMetrics();
  }
}
