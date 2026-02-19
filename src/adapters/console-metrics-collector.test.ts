import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../interfaces/logger.js";
import type { MetricsEventType } from "../interfaces/metrics.js";
import { ConsoleMetricsCollector } from "./console-metrics-collector.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockLogger(): Logger & { debug: ReturnType<typeof vi.fn> } {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

const ts = Date.now();

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ConsoleMetricsCollector", () => {
  let logger: ReturnType<typeof createMockLogger>;
  let collector: ConsoleMetricsCollector;

  beforeEach(() => {
    logger = createMockLogger();
    collector = new ConsoleMetricsCollector(logger);
  });

  // -----------------------------------------------------------------------
  // session:created
  // -----------------------------------------------------------------------

  describe("session:created", () => {
    it("logs info and initializes connection tracking", () => {
      const event: MetricsEventType = {
        type: "session:created",
        sessionId: "sess-1",
        timestamp: ts,
      };

      collector.recordEvent(event);

      expect(logger.info).toHaveBeenCalledWith("[METRICS] Session created: sess-1");

      const stats = collector.getStats({ sessionId: "sess-1" });
      expect(stats.connections).toEqual({ backend: 0, consumers: 0 });
      expect(stats.eventCount).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // session:closed
  // -----------------------------------------------------------------------

  describe("session:closed", () => {
    it("logs info and cleans up maps", () => {
      collector.recordEvent({ type: "session:created", sessionId: "sess-1", timestamp: ts });
      collector.recordEvent({ type: "session:closed", sessionId: "sess-1", timestamp: ts });

      expect(logger.info).toHaveBeenCalledWith("[METRICS] Session closed: sess-1");

      const stats = collector.getStats({ sessionId: "sess-1" });
      expect(stats.eventCount).toBe(0);
      expect(stats.connections).toEqual({ backend: 0, consumers: 0 });
    });

    it("logs info with optional reason", () => {
      collector.recordEvent({
        type: "session:closed",
        sessionId: "sess-1",
        reason: "timeout",
        timestamp: ts,
      });

      expect(logger.info).toHaveBeenCalledWith("[METRICS] Session closed: sess-1 (timeout)");
    });
  });

  // -----------------------------------------------------------------------
  // consumer:connected
  // -----------------------------------------------------------------------

  describe("consumer:connected", () => {
    it("increments consumer count and logs debug", () => {
      collector.recordEvent({ type: "session:created", sessionId: "sess-1", timestamp: ts });
      collector.recordEvent({
        type: "consumer:connected",
        sessionId: "sess-1",
        userId: "user-a",
        timestamp: ts,
      });

      expect(logger.debug).toHaveBeenCalledWith(
        "[METRICS] Consumer connected: session=sess-1, userId=user-a, total=1",
      );

      const stats = collector.getStats({ sessionId: "sess-1" });
      expect((stats.connections as { consumers: number }).consumers).toBe(1);
    });

    it("initializes connection tracking when session not previously created", () => {
      collector.recordEvent({
        type: "consumer:connected",
        sessionId: "sess-2",
        userId: "user-b",
        timestamp: ts,
      });

      const stats = collector.getStats({ sessionId: "sess-2" });
      expect((stats.connections as { consumers: number }).consumers).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // consumer:disconnected
  // -----------------------------------------------------------------------

  describe("consumer:disconnected", () => {
    it("decrements consumer count and logs debug", () => {
      collector.recordEvent({ type: "session:created", sessionId: "sess-1", timestamp: ts });
      collector.recordEvent({
        type: "consumer:connected",
        sessionId: "sess-1",
        userId: "user-a",
        timestamp: ts,
      });
      collector.recordEvent({
        type: "consumer:disconnected",
        sessionId: "sess-1",
        userId: "user-a",
        timestamp: ts,
      });

      expect(logger.debug).toHaveBeenCalledWith(
        "[METRICS] Consumer disconnected: session=sess-1, userId=user-a",
      );

      const stats = collector.getStats({ sessionId: "sess-1" });
      expect((stats.connections as { consumers: number }).consumers).toBe(0);
    });

    it("handles disconnect when no connection tracking exists", () => {
      collector.recordEvent({
        type: "consumer:disconnected",
        sessionId: "sess-unknown",
        userId: "user-a",
        timestamp: ts,
      });

      expect(logger.debug).toHaveBeenCalledWith(
        "[METRICS] Consumer disconnected: session=sess-unknown, userId=user-a",
      );
    });
  });

  // -----------------------------------------------------------------------
  // backend:connected
  // -----------------------------------------------------------------------

  describe("backend:connected", () => {
    it("sets backend=1 and logs debug", () => {
      collector.recordEvent({ type: "session:created", sessionId: "sess-1", timestamp: ts });
      collector.recordEvent({ type: "backend:connected", sessionId: "sess-1", timestamp: ts });

      expect(logger.debug).toHaveBeenCalledWith("[METRICS] Backend connected: session=sess-1");

      const stats = collector.getStats({ sessionId: "sess-1" });
      expect((stats.connections as { backend: number }).backend).toBe(1);
    });

    it("initializes connection tracking when session not previously created", () => {
      collector.recordEvent({ type: "backend:connected", sessionId: "sess-3", timestamp: ts });

      const stats = collector.getStats({ sessionId: "sess-3" });
      expect((stats.connections as { backend: number }).backend).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // backend:disconnected
  // -----------------------------------------------------------------------

  describe("backend:disconnected", () => {
    it("sets backend=0 and logs debug", () => {
      collector.recordEvent({ type: "session:created", sessionId: "sess-1", timestamp: ts });
      collector.recordEvent({ type: "backend:connected", sessionId: "sess-1", timestamp: ts });
      collector.recordEvent({ type: "backend:disconnected", sessionId: "sess-1", timestamp: ts });

      expect(logger.debug).toHaveBeenCalledWith("[METRICS] Backend disconnected: session=sess-1");

      const stats = collector.getStats({ sessionId: "sess-1" });
      expect((stats.connections as { backend: number }).backend).toBe(0);
    });

    it("handles disconnect when no connection tracking exists", () => {
      collector.recordEvent({
        type: "backend:disconnected",
        sessionId: "sess-unknown",
        timestamp: ts,
      });

      expect(logger.debug).toHaveBeenCalledWith(
        "[METRICS] Backend disconnected: session=sess-unknown",
      );
    });
  });

  // -----------------------------------------------------------------------
  // message:received
  // -----------------------------------------------------------------------

  describe("message:received", () => {
    it("logs debug with source and messageType", () => {
      collector.recordEvent({
        type: "message:received",
        sessionId: "sess-1",
        source: "cli",
        messageType: "assistant",
        timestamp: ts,
      });

      expect(logger.debug).toHaveBeenCalledWith(
        "[METRICS] Message received: session=sess-1, source=cli, type=assistant",
      );
    });

    it("logs 'unknown' when messageType is missing", () => {
      collector.recordEvent({
        type: "message:received",
        sessionId: "sess-1",
        source: "consumer",
        timestamp: ts,
      });

      expect(logger.debug).toHaveBeenCalledWith(
        "[METRICS] Message received: session=sess-1, source=consumer, type=unknown",
      );
    });
  });

  // -----------------------------------------------------------------------
  // message:sent
  // -----------------------------------------------------------------------

  describe("message:sent", () => {
    it("logs debug with target and recipientCount", () => {
      collector.recordEvent({
        type: "message:sent",
        sessionId: "sess-1",
        target: "broadcast",
        recipientCount: 3,
        timestamp: ts,
      });

      expect(logger.debug).toHaveBeenCalledWith(
        "[METRICS] Message sent: session=sess-1, target=broadcast, recipients=3",
      );
    });

    it("defaults recipientCount to 1 when not provided", () => {
      collector.recordEvent({
        type: "message:sent",
        sessionId: "sess-1",
        target: "cli",
        timestamp: ts,
      });

      expect(logger.debug).toHaveBeenCalledWith(
        "[METRICS] Message sent: session=sess-1, target=cli, recipients=1",
      );
    });
  });

  // -----------------------------------------------------------------------
  // message:dropped
  // -----------------------------------------------------------------------

  describe("message:dropped", () => {
    it("logs warn with reason", () => {
      collector.recordEvent({
        type: "message:dropped",
        sessionId: "sess-1",
        reason: "queue full",
        timestamp: ts,
      });

      expect(logger.warn).toHaveBeenCalledWith(
        "[METRICS] Message dropped: session=sess-1, reason=queue full",
      );
    });
  });

  // -----------------------------------------------------------------------
  // auth:failed
  // -----------------------------------------------------------------------

  describe("auth:failed", () => {
    it("logs warn with reason", () => {
      collector.recordEvent({
        type: "auth:failed",
        sessionId: "sess-1",
        reason: "invalid token",
        timestamp: ts,
      });

      expect(logger.warn).toHaveBeenCalledWith(
        "[METRICS] Authentication failed: session=sess-1, reason=invalid token",
      );
    });
  });

  // -----------------------------------------------------------------------
  // send:failed
  // -----------------------------------------------------------------------

  describe("send:failed", () => {
    it("logs warn with target and reason", () => {
      collector.recordEvent({
        type: "send:failed",
        sessionId: "sess-1",
        target: "consumer",
        reason: "socket closed",
        timestamp: ts,
      });

      expect(logger.warn).toHaveBeenCalledWith(
        "[METRICS] Send failed: session=sess-1, target=consumer, reason=socket closed",
      );
    });
  });

  // -----------------------------------------------------------------------
  // error
  // -----------------------------------------------------------------------

  describe("error", () => {
    it("logs warn with source, sessionId, error, and severity", () => {
      collector.recordEvent({
        type: "error",
        sessionId: "sess-1",
        source: "ws-bridge",
        error: "connection reset",
        severity: "error",
        timestamp: ts,
      });

      expect(logger.warn).toHaveBeenCalledWith(
        "[METRICS] Error in ws-bridge (session=sess-1): connection reset [error]",
      );
    });

    it("omits sessionId from log when not provided", () => {
      collector.recordEvent({
        type: "error",
        source: "server",
        error: "startup failure",
        severity: "critical",
        timestamp: ts,
      });

      expect(logger.warn).toHaveBeenCalledWith(
        "[METRICS] Error in server: startup failure [critical]",
      );
    });
  });

  // -----------------------------------------------------------------------
  // ratelimit:exceeded
  // -----------------------------------------------------------------------

  describe("ratelimit:exceeded", () => {
    it("logs warn with sessionId and source", () => {
      collector.recordEvent({
        type: "ratelimit:exceeded",
        sessionId: "sess-1",
        source: "consumer",
        timestamp: ts,
      });

      expect(logger.warn).toHaveBeenCalledWith(
        "[METRICS] Rate limit exceeded: session=sess-1, source=consumer",
      );
    });
  });

  // -----------------------------------------------------------------------
  // latency
  // -----------------------------------------------------------------------

  describe("latency", () => {
    it("logs debug with operation and durationMs", () => {
      collector.recordEvent({
        type: "latency",
        sessionId: "sess-1",
        operation: "auth",
        durationMs: 42,
        timestamp: ts,
      });

      expect(logger.debug).toHaveBeenCalledWith(
        "[METRICS] Latency: session=sess-1, operation=auth, durationMs=42",
      );
    });
  });

  // -----------------------------------------------------------------------
  // queue:depth
  // -----------------------------------------------------------------------

  describe("queue:depth", () => {
    it("warns when depth exceeds 80% of maxCapacity", () => {
      collector.recordEvent({
        type: "queue:depth",
        sessionId: "sess-1",
        queueType: "pending_messages",
        depth: 45,
        maxCapacity: 50,
        timestamp: ts,
      });

      expect(logger.warn).toHaveBeenCalledWith(
        "[METRICS] Queue depth warning: session=sess-1, type=pending_messages, depth=45/50",
      );
    });

    it("does not warn when depth is within safe threshold", () => {
      collector.recordEvent({
        type: "queue:depth",
        sessionId: "sess-1",
        queueType: "pending_messages",
        depth: 10,
        maxCapacity: 50,
        timestamp: ts,
      });

      expect(logger.warn).not.toHaveBeenCalled();
    });

    it("uses default maxCapacity of 50 when not provided", () => {
      // 80% of 50 = 40, so depth=41 should warn
      collector.recordEvent({
        type: "queue:depth",
        sessionId: "sess-1",
        queueType: "pending_permissions",
        depth: 41,
        timestamp: ts,
      });

      expect(logger.warn).toHaveBeenCalledWith(
        "[METRICS] Queue depth warning: session=sess-1, type=pending_permissions, depth=41/undefined",
      );
    });
  });

  // -----------------------------------------------------------------------
  // getStats
  // -----------------------------------------------------------------------

  describe("getStats", () => {
    it("returns per-session stats when sessionId is provided", () => {
      collector.recordEvent({ type: "session:created", sessionId: "sess-1", timestamp: ts });
      collector.recordEvent({
        type: "consumer:connected",
        sessionId: "sess-1",
        userId: "user-a",
        timestamp: ts,
      });

      const stats = collector.getStats({ sessionId: "sess-1" });

      expect(stats).toEqual({
        sessionId: "sess-1",
        eventCount: 2,
        connections: { backend: 0, consumers: 1 },
      });
    });

    it("returns defaults for unknown sessionId", () => {
      const stats = collector.getStats({ sessionId: "unknown" });

      expect(stats).toEqual({
        sessionId: "unknown",
        eventCount: 0,
        connections: { backend: 0, consumers: 0 },
      });
    });

    it("returns global stats when no sessionId is provided", () => {
      collector.recordEvent({ type: "session:created", sessionId: "sess-1", timestamp: ts });
      collector.recordEvent({ type: "session:created", sessionId: "sess-2", timestamp: ts });
      collector.recordEvent({ type: "backend:connected", sessionId: "sess-1", timestamp: ts });
      collector.recordEvent({
        type: "consumer:connected",
        sessionId: "sess-2",
        userId: "user-a",
        timestamp: ts,
      });
      collector.recordEvent({
        type: "consumer:connected",
        sessionId: "sess-2",
        userId: "user-b",
        timestamp: ts,
      });

      const stats = collector.getStats();

      expect(stats).toEqual({
        totalSessions: 2,
        backendConnected: 1,
        totalConsumers: 2,
        totalEvents: 5,
      });
    });
  });

  // -----------------------------------------------------------------------
  // reset
  // -----------------------------------------------------------------------

  describe("reset", () => {
    it("clears all session data", () => {
      collector.recordEvent({ type: "session:created", sessionId: "sess-1", timestamp: ts });
      collector.recordEvent({ type: "backend:connected", sessionId: "sess-1", timestamp: ts });

      collector.reset();

      const stats = collector.getStats();
      expect(stats).toEqual({
        totalSessions: 0,
        backendConnected: 0,
        totalConsumers: 0,
        totalEvents: 0,
      });
    });
  });

  // -----------------------------------------------------------------------
  // Events without sessionId
  // -----------------------------------------------------------------------

  describe("events without sessionId", () => {
    it("uses 'global' as sessionId when event has no sessionId", () => {
      collector.recordEvent({
        type: "error",
        source: "server",
        error: "startup failure",
        severity: "warning",
        timestamp: ts,
      } as MetricsEventType);

      const stats = collector.getStats({ sessionId: "global" });
      expect(stats.eventCount).toBe(1);
    });
  });
});
