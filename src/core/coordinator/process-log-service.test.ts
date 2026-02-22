import { describe, expect, it } from "vitest";
import { ProcessLogService } from "./process-log-service.js";

describe("ProcessLogService", () => {
  it("appends lines and retrieves them via get()", () => {
    const svc = new ProcessLogService();
    svc.append("s1", "stdout", "hello\nworld\n");
    expect(svc.get("s1")).toEqual(["hello", "world"]);
  });

  it("returns empty array for unknown session", () => {
    const svc = new ProcessLogService();
    expect(svc.get("unknown")).toEqual([]);
  });

  it("filters blank lines", () => {
    const svc = new ProcessLogService();
    svc.append("s1", "stdout", "a\n\n  \nb\n");
    expect(svc.get("s1")).toEqual(["a", "b"]);
  });

  it("redacts secrets in output", () => {
    const svc = new ProcessLogService();
    const redacted = svc.append("s1", "stdout", "key=sk-ant-abc123def456\n");
    expect(redacted).toContain("[REDACTED]");
    expect(redacted).not.toContain("sk-ant-abc123def456");
    expect(svc.get("s1")[0]).toContain("[REDACTED]");
  });

  it("returns the redacted text from append()", () => {
    const svc = new ProcessLogService();
    const result = svc.append("s1", "stderr", "safe line\n");
    expect(result).toBe("safe line\n");
  });

  it("enforces MAX_LOG_LINES ring buffer (500)", () => {
    const svc = new ProcessLogService();
    const lines = Array.from({ length: 600 }, (_, i) => `line-${i}`).join("\n");
    svc.append("s1", "stdout", lines);

    const buf = svc.get("s1");
    expect(buf.length).toBe(500);
    // Oldest lines are dropped; newest survive
    expect(buf[0]).toBe("line-100");
    expect(buf[buf.length - 1]).toBe("line-599");
  });

  it("ring buffer works across multiple appends", () => {
    const svc = new ProcessLogService();
    // Fill to 490
    const batch1 = Array.from({ length: 490 }, (_, i) => `a-${i}`).join("\n");
    svc.append("s1", "stdout", batch1);
    expect(svc.get("s1").length).toBe(490);

    // Push 20 more → 510 total → trimmed to 500
    const batch2 = Array.from({ length: 20 }, (_, i) => `b-${i}`).join("\n");
    svc.append("s1", "stdout", batch2);
    expect(svc.get("s1").length).toBe(500);
    expect(svc.get("s1")[0]).toBe("a-10");
    expect(svc.get("s1")[svc.get("s1").length - 1]).toBe("b-19");
  });

  it("cleanup removes the buffer for a session", () => {
    const svc = new ProcessLogService();
    svc.append("s1", "stdout", "data\n");
    expect(svc.get("s1").length).toBe(1);

    svc.cleanup("s1");
    expect(svc.get("s1")).toEqual([]);
  });

  it("cleanup is safe for unknown sessions", () => {
    const svc = new ProcessLogService();
    expect(() => svc.cleanup("nope")).not.toThrow();
  });

  it("isolates buffers per session", () => {
    const svc = new ProcessLogService();
    svc.append("s1", "stdout", "from-s1\n");
    svc.append("s2", "stderr", "from-s2\n");
    expect(svc.get("s1")).toEqual(["from-s1"]);
    expect(svc.get("s2")).toEqual(["from-s2"]);

    svc.cleanup("s1");
    expect(svc.get("s1")).toEqual([]);
    expect(svc.get("s2")).toEqual(["from-s2"]);
  });
});
