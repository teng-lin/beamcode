import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type MessageTracer,
  MessageTracerImpl,
  noopTracer,
  type TraceEvent,
} from "./message-tracer.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createTracer(overrides?: Partial<ConstructorParameters<typeof MessageTracerImpl>[0]>) {
  const lines: string[] = [];
  let clock = 1_000_000_000n; // start at 1s in nanoseconds
  const tracer = new MessageTracerImpl({
    level: "smart",
    allowSensitive: false,
    write: (line) => lines.push(line),
    now: () => clock,
    staleTimeoutMs: 100, // short for testing
    ...overrides,
  });
  const advance = (ms: number) => {
    clock += BigInt(ms) * 1_000_000n;
  };
  const events = () => lines.map((l) => JSON.parse(l) as TraceEvent);
  return { tracer, lines, events, advance };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("MessageTracerImpl", () => {
  describe("send/recv", () => {
    it("emits trace events with correct fields", () => {
      const { tracer, events } = createTracer();
      tracer.send(
        "bridge",
        "user_message",
        { content: "hello" },
        {
          sessionId: "s1",
          traceId: "t_fixed",
        },
      );
      const evts = events();
      expect(evts).toHaveLength(1);
      const e = evts[0];
      expect(e.trace).toBe(true);
      expect(e.traceId).toBe("t_fixed");
      expect(e.layer).toBe("bridge");
      expect(e.direction).toBe("send");
      expect(e.messageType).toBe("user_message");
      expect(e.sessionId).toBe("s1");
      expect(e.seq).toBe(1);
      expect(e.elapsed_ms).toBe(0);
      expect(e.ts).toBeDefined();
      tracer.destroy();
    });

    it("increments seq per session", () => {
      const { tracer, events } = createTracer();
      tracer.recv("bridge", "msg1", {}, { sessionId: "s1", traceId: "t_1" });
      tracer.recv("bridge", "msg2", {}, { sessionId: "s1", traceId: "t_2" });
      tracer.recv("bridge", "msg3", {}, { sessionId: "s2", traceId: "t_3" });
      const evts = events();
      expect(evts[0].seq).toBe(1);
      expect(evts[1].seq).toBe(2);
      expect(evts[2].seq).toBe(1); // different session
      tracer.destroy();
    });

    it("calculates elapsed_ms from monotonic clock", () => {
      const { tracer, events, advance } = createTracer();
      tracer.recv("bridge", "msg", {}, { traceId: "t_1", sessionId: "s1" });
      advance(50);
      tracer.send("bridge", "msg", {}, { traceId: "t_1", sessionId: "s1" });
      const evts = events();
      expect(evts[0].elapsed_ms).toBe(0);
      expect(evts[1].elapsed_ms).toBe(50);
      tracer.destroy();
    });

    it("generates traceId when not provided", () => {
      const { tracer, events } = createTracer();
      tracer.send("bridge", "msg", {});
      const e = events()[0];
      expect(e.traceId).toMatch(/^t_[a-f0-9]{8}$/);
      tracer.destroy();
    });
  });

  describe("translate", () => {
    it("emits translate event with from/to/diff", () => {
      const { tracer, events } = createTracer();
      tracer.translate(
        "normalizeInbound",
        "T1",
        { format: "InboundMessage", body: { type: "user_message" } },
        { format: "UnifiedMessage", body: { type: "user_message", role: "user" } },
        { traceId: "t_abc", sessionId: "s1" },
      );
      const e = events()[0];
      expect(e.direction).toBe("translate");
      expect(e.translator).toBe("normalizeInbound");
      expect(e.boundary).toBe("T1");
      expect(e.messageType).toBe("T1:normalizeInbound");
      expect(e.from?.format).toBe("InboundMessage");
      expect(e.to?.format).toBe("UnifiedMessage");
      expect(e.diff).toBeDefined();
      expect(e.diff!.length).toBeGreaterThan(0);
      tracer.destroy();
    });

    it("skips diff when one side is a string (e.g. NDJSON)", () => {
      const { tracer, events } = createTracer();
      tracer.translate(
        "toNDJSON",
        "T2",
        { format: "UnifiedMessage", body: { type: "user_message" } },
        { format: "Claude NDJSON", body: '{"type":"user","content":"hi"}' },
        { traceId: "t_t2", sessionId: "s1" },
      );
      const e = events()[0];
      expect(e.diff).toBeUndefined();
      tracer.destroy();
    });

    it("redacts sensitive values in diff field", () => {
      const { tracer, events } = createTracer();
      tracer.translate(
        "fn",
        "T1",
        { format: "A", body: { token: "secret123", name: "test" } },
        { format: "B", body: { token: "secret456", name: "test" } },
        { traceId: "t_redact", sessionId: "s1" },
      );
      const e = events()[0];
      // The diff should show the change but with redacted values
      const diffStr = e.diff?.join("\n") ?? "";
      expect(diffStr).not.toContain("secret123");
      expect(diffStr).not.toContain("secret456");
      tracer.destroy();
    });
  });

  describe("error", () => {
    it("emits error event", () => {
      const { tracer, events } = createTracer();
      tracer.error("bridge", "user_message", "validation_failed", {
        traceId: "t_err",
        sessionId: "s1",
        zodErrors: [{ path: "content", message: "Required" }],
        action: "dropped",
      });
      const e = events()[0];
      expect(e.error).toBe("validation_failed");
      expect(e.zodErrors).toHaveLength(1);
      expect(e.action).toBe("dropped");
      tracer.destroy();
    });
  });

  describe("smart truncation", () => {
    it("truncates long text content", () => {
      const { tracer, events } = createTracer({ level: "smart" });
      const longContent = "a".repeat(500);
      tracer.send(
        "bridge",
        "user_message",
        { content: longContent },
        {
          traceId: "t_1",
        },
      );
      const body = events()[0].body as Record<string, unknown>;
      expect(typeof body.content).toBe("string");
      expect((body.content as string).length).toBeLessThan(300);
      expect(body.content as string).toContain("...[");
      tracer.destroy();
    });

    it("replaces message_history with count", () => {
      const { tracer, events } = createTracer({ level: "smart" });
      const history = Array.from({ length: 42 }, (_, i) => ({
        role: "user",
        content: `msg ${i}`,
      }));
      tracer.send(
        "bridge",
        "session_init",
        { message_history: history },
        {
          traceId: "t_1",
        },
      );
      const body = events()[0].body as Record<string, unknown>;
      expect(body.message_history).toBe("[42 messages]");
      tracer.destroy();
    });
  });

  describe("headers level", () => {
    it("includes size_bytes but not body", () => {
      const { tracer, events } = createTracer({ level: "headers" });
      tracer.send(
        "bridge",
        "user_message",
        { content: "hello" },
        {
          traceId: "t_1",
        },
      );
      const e = events()[0];
      expect(e.size_bytes).toBeGreaterThan(0);
      expect(e.body).toBeUndefined();
      tracer.destroy();
    });
  });

  describe("stale detection", () => {
    it("emits trace_stale after timeout", async () => {
      const { tracer, events, advance } = createTracer({ staleTimeoutMs: 50 });
      tracer.recv("bridge", "msg", {}, { traceId: "t_stale", sessionId: "s1" });
      advance(100);
      // Trigger sweep manually by waiting for the interval
      await new Promise((resolve) => setTimeout(resolve, 100));
      const staleEvents = events().filter((e) => e.messageType === "trace_stale");
      expect(staleEvents.length).toBeGreaterThanOrEqual(1);
      expect(staleEvents[0].error).toContain("trace stale");
      tracer.destroy();
    });
  });

  describe("summary", () => {
    it("returns summary stats", () => {
      const { tracer } = createTracer();
      // Send + recv creates a trace, then a bridge:send completes it
      tracer.recv("bridge", "msg", {}, { traceId: "t_1", sessionId: "s1" });
      tracer.send("bridge", "msg", {}, { traceId: "t_1", sessionId: "s1" });
      const summary = tracer.summary("s1");
      expect(summary.complete).toBe(1);
      expect(summary.totalTraces).toBeGreaterThanOrEqual(1);
      tracer.destroy();
    });

    it("does not double-count errors", () => {
      const { tracer } = createTracer();
      // An error trace that is also in openTraces should be counted once
      tracer.error("bridge", "msg", "fail", { traceId: "t_err", sessionId: "s1" });
      const summary = tracer.summary("s1");
      expect(summary.errors).toBe(1);
      tracer.destroy();
    });
  });
});

describe("noopTracer", () => {
  it("has zero overhead (all methods are no-ops)", () => {
    noopTracer.send("bridge", "msg", {});
    noopTracer.recv("bridge", "msg", {});
    noopTracer.translate("fn", "T1", { format: "a", body: {} }, { format: "b", body: {} });
    noopTracer.error("bridge", "msg", "err");
    noopTracer.destroy();
    expect(noopTracer.summary("s1")).toEqual({
      totalTraces: 0,
      complete: 0,
      stale: 0,
      errors: 0,
      avgRoundTripMs: 0,
    });
  });
});
