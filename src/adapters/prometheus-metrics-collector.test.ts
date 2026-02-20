import { describe, expect, it } from "vitest";
import type { MetricsEventType } from "../interfaces/metrics.js";
import { PrometheusMetricsCollector } from "./prometheus-metrics-collector.js";

// Dynamic import so test fails gracefully if prom-client missing
let promClient: typeof import("prom-client");
try {
  promClient = await import("prom-client");
} catch {
  // Tests will be skipped below
}

const describeIfProm = promClient! ? describe : describe.skip;

function makeCollector() {
  return new PrometheusMetricsCollector(promClient);
}

describeIfProm("PrometheusMetricsCollector", () => {
  it("records session:created as counter + gauge", async () => {
    const c = makeCollector();
    c.recordEvent({
      timestamp: Date.now(),
      type: "session:created",
      sessionId: "s1",
    } as MetricsEventType);

    const output = await c.getMetricsOutput();
    expect(output).toContain("beamcode_sessions_created_total 1");
    expect(output).toContain("beamcode_sessions_active 1");
  });

  it("decrements session gauge on close", async () => {
    const c = makeCollector();
    c.recordEvent({
      timestamp: Date.now(),
      type: "session:created",
      sessionId: "s1",
    } as MetricsEventType);
    c.recordEvent({
      timestamp: Date.now(),
      type: "session:closed",
      sessionId: "s1",
    } as MetricsEventType);

    const output = await c.getMetricsOutput();
    expect(output).toContain("beamcode_sessions_active 0");
    // Counter should still show 1 (lifetime)
    expect(output).toContain("beamcode_sessions_created_total 1");
  });

  it("tracks consumer and backend gauges", async () => {
    const c = makeCollector();
    c.recordEvent({
      timestamp: Date.now(),
      type: "consumer:connected",
      sessionId: "s1",
      userId: "u1",
    } as MetricsEventType);
    c.recordEvent({
      timestamp: Date.now(),
      type: "backend:connected",
      sessionId: "s1",
    } as MetricsEventType);

    const output = await c.getMetricsOutput();
    expect(output).toContain("beamcode_consumers_active 1");
    expect(output).toContain("beamcode_backends_active 1");
  });

  it("tracks message counters with labels", async () => {
    const c = makeCollector();
    c.recordEvent({
      timestamp: Date.now(),
      type: "message:received",
      sessionId: "s1",
      source: "cli",
    } as MetricsEventType);
    c.recordEvent({
      timestamp: Date.now(),
      type: "message:sent",
      sessionId: "s1",
      target: "consumer",
    } as MetricsEventType);

    const output = await c.getMetricsOutput();
    expect(output).toContain('beamcode_messages_received_total{source="cli"} 1');
    expect(output).toContain('beamcode_messages_sent_total{target="consumer"} 1');
  });

  it("tracks error counter with severity and source labels", async () => {
    const c = makeCollector();
    c.recordEvent({
      timestamp: Date.now(),
      type: "error",
      source: "bridge",
      error: "test error",
      severity: "error",
    } as MetricsEventType);

    const output = await c.getMetricsOutput();
    expect(output).toContain('beamcode_errors_total{severity="error",source="bridge"} 1');
  });

  it("tracks latency as histogram", async () => {
    const c = makeCollector();
    c.recordEvent({
      timestamp: Date.now(),
      type: "latency",
      sessionId: "s1",
      operation: "auth",
      durationMs: 150,
    } as MetricsEventType);

    const output = await c.getMetricsOutput();
    expect(output).toContain("beamcode_operation_duration_seconds_bucket");
    expect(output).toContain('operation="auth"');
  });

  it("tracks queue depth gauge", async () => {
    const c = makeCollector();
    c.recordEvent({
      timestamp: Date.now(),
      type: "queue:depth",
      sessionId: "s1",
      queueType: "pending_messages",
      depth: 42,
    } as MetricsEventType);

    const output = await c.getMetricsOutput();
    expect(output).toContain('beamcode_queue_depth{queue_type="pending_messages"} 42');
  });

  it("tracks auth:failed, send:failed, ratelimit:exceeded, message:dropped", async () => {
    const c = makeCollector();
    c.recordEvent({
      timestamp: Date.now(),
      type: "auth:failed",
      sessionId: "s1",
      reason: "bad token",
    } as MetricsEventType);
    c.recordEvent({
      timestamp: Date.now(),
      type: "send:failed",
      sessionId: "s1",
      target: "cli",
      reason: "timeout",
    } as MetricsEventType);
    c.recordEvent({
      timestamp: Date.now(),
      type: "ratelimit:exceeded",
      sessionId: "s1",
      source: "consumer",
    } as MetricsEventType);
    c.recordEvent({
      timestamp: Date.now(),
      type: "message:dropped",
      sessionId: "s1",
      reason: "full",
    } as MetricsEventType);

    const output = await c.getMetricsOutput();
    expect(output).toContain("beamcode_auth_failures_total 1");
    expect(output).toContain('beamcode_send_failures_total{target="cli"} 1');
    expect(output).toContain('beamcode_ratelimit_exceeded_total{source="consumer"} 1');
    expect(output).toContain("beamcode_messages_dropped_total 1");
  });

  it("supports custom prefix", async () => {
    const c = new PrometheusMetricsCollector(promClient, { prefix: "myapp_" });
    c.recordEvent({
      timestamp: Date.now(),
      type: "session:created",
      sessionId: "s1",
    } as MetricsEventType);

    const output = await c.getMetricsOutput();
    expect(output).toContain("myapp_sessions_created_total 1");
  });

  it("reset clears all metrics", async () => {
    const c = makeCollector();
    c.recordEvent({
      timestamp: Date.now(),
      type: "session:created",
      sessionId: "s1",
    } as MetricsEventType);
    c.reset();

    const output = await c.getMetricsOutput();
    expect(output).toContain("beamcode_sessions_created_total 0");
  });
});
