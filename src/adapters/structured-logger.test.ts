import { describe, expect, it } from "vitest";
import { LogLevel, StructuredLogger } from "./structured-logger.js";

describe("StructuredLogger", () => {
  it("outputs JSON lines to the writer", () => {
    const lines: string[] = [];
    const logger = new StructuredLogger({ writer: (line) => lines.push(line) });

    logger.info("server started", { port: 3456 });

    const parsed = JSON.parse(lines[0]);
    expect(parsed.level).toBe("info");
    expect(parsed.msg).toBe("server started");
    expect(parsed.port).toBe(3456);
    expect(parsed.time).toBeTypeOf("string"); // ISO 8601
  });

  it("respects log level filtering", () => {
    const lines: string[] = [];
    const logger = new StructuredLogger({
      writer: (line) => lines.push(line),
      level: LogLevel.WARN,
    });

    logger.debug("hidden");
    logger.info("hidden");
    logger.warn("visible");
    logger.error("visible");

    expect(lines).toHaveLength(2);
  });

  it("includes component name when set", () => {
    const lines: string[] = [];
    const logger = new StructuredLogger({
      writer: (line) => lines.push(line),
      component: "session-bridge",
    });

    logger.info("test");

    const parsed = JSON.parse(lines[0]);
    expect(parsed.component).toBe("session-bridge");
  });

  it("passes correlation ID through ctx parameter", () => {
    const lines: string[] = [];
    const logger = new StructuredLogger({ writer: (line) => lines.push(line) });

    logger.info("message received", { correlationId: "sess-abc-123" });

    const parsed = JSON.parse(lines[0]);
    expect(parsed.correlationId).toBe("sess-abc-123");
  });

  it("serializes error objects with stack", () => {
    const lines: string[] = [];
    const logger = new StructuredLogger({ writer: (line) => lines.push(line) });

    logger.error("failed", { error: new Error("boom") });

    const parsed = JSON.parse(lines[0]);
    expect(parsed.error).toBe("boom");
    expect(parsed.errorStack).toContain("Error: boom");
  });

  it("does not allow ctx to overwrite reserved fields", () => {
    const lines: string[] = [];
    const logger = new StructuredLogger({
      writer: (line) => lines.push(line),
      component: "test",
    });

    logger.info("spoofed", { level: "debug", time: "fake", msg: "injected", component: "evil" });

    const parsed = JSON.parse(lines[0]);
    expect(parsed.level).toBe("info");
    expect(parsed.msg).toBe("spoofed");
    expect(parsed.component).toBe("test");
    expect(parsed.time).not.toBe("fake");
  });

  it("survives circular references in ctx", () => {
    const lines: string[] = [];
    const logger = new StructuredLogger({ writer: (line) => lines.push(line) });

    const circular: Record<string, unknown> = { key: "value" };
    circular.self = circular;

    // Should not throw
    logger.error("circular data", circular);

    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.msg).toBe("circular data");
  });
});
