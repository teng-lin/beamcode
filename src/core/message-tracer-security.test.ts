import { describe, expect, it } from "vitest";
import { MessageTracerImpl, type TraceEvent } from "./message-tracer.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createTracer(overrides?: Partial<ConstructorParameters<typeof MessageTracerImpl>[0]>) {
  const lines: string[] = [];
  const tracer = new MessageTracerImpl({
    level: "smart",
    allowSensitive: false,
    write: (line) => lines.push(line),
    now: () => 1_000_000_000n,
    staleTimeoutMs: 60_000,
    ...overrides,
  });
  const events = () => lines.map((l) => JSON.parse(l) as TraceEvent);
  return { tracer, lines, events };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("MessageTracer — security", () => {
  describe("sensitive key redaction", () => {
    const sensitiveKeys = [
      "authorization",
      "cookie",
      "set-cookie",
      "api_key",
      "apikey",
      "token",
      "access_token",
      "refresh_token",
      "secret",
      "password",
      "credential",
      "private_key",
    ];

    for (const key of sensitiveKeys) {
      it(`redacts "${key}" in smart mode`, () => {
        const { tracer, events } = createTracer({ level: "smart" });
        const payload = { [key]: "super-secret-value", other: "visible" };
        tracer.send("bridge", "msg", payload, { traceId: "t_1" });
        const body = events()[0].body as Record<string, unknown>;
        expect(body[key]).toBe("[REDACTED]");
        expect(body.other).toBe("visible");
        tracer.destroy();
      });
    }

    it("redacts nested sensitive keys", () => {
      const { tracer, events } = createTracer({ level: "smart" });
      tracer.send(
        "bridge",
        "msg",
        {
          headers: { authorization: "Bearer xyz", accept: "json" },
        },
        { traceId: "t_1" },
      );
      const body = events()[0].body as Record<string, unknown>;
      const headers = body.headers as Record<string, unknown>;
      expect(headers.authorization).toBe("[REDACTED]");
      expect(headers.accept).toBe("json");
      tracer.destroy();
    });

    it("redacts in translate from/to bodies", () => {
      const { tracer, events } = createTracer({ level: "smart" });
      tracer.translate(
        "fn",
        "T1",
        { format: "A", body: { token: "secret123" } },
        { format: "B", body: { password: "pass456" } },
        { traceId: "t_1" },
      );
      const e = events()[0];
      expect((e.from!.body as Record<string, unknown>).token).toBe("[REDACTED]");
      expect((e.to!.body as Record<string, unknown>).password).toBe("[REDACTED]");
      tracer.destroy();
    });
  });

  describe("full level without allowSensitive", () => {
    it("still redacts sensitive keys when allowSensitive is false", () => {
      const { tracer, events } = createTracer({
        level: "full",
        allowSensitive: false,
      });
      tracer.send(
        "bridge",
        "msg",
        { api_key: "key123", data: "ok" },
        {
          traceId: "t_1",
        },
      );
      const body = events()[0].body as Record<string, unknown>;
      expect(body.api_key).toBe("[REDACTED]");
      expect(body.data).toBe("ok");
      tracer.destroy();
    });
  });

  describe("full level with allowSensitive", () => {
    it("includes sensitive values when allowSensitive is true", () => {
      const { tracer, events } = createTracer({
        level: "full",
        allowSensitive: true,
      });
      tracer.send(
        "bridge",
        "msg",
        { api_key: "key123", data: "ok" },
        {
          traceId: "t_1",
        },
      );
      const body = events()[0].body as Record<string, unknown>;
      expect(body.api_key).toBe("key123");
      expect(body.data).toBe("ok");
      tracer.destroy();
    });
  });

  describe("headers level", () => {
    it("never includes body regardless of content", () => {
      const { tracer, events } = createTracer({ level: "headers" });
      tracer.send(
        "bridge",
        "msg",
        { secret: "exposed?", data: "test" },
        {
          traceId: "t_1",
        },
      );
      const e = events()[0];
      expect(e.body).toBeUndefined();
      expect(e.size_bytes).toBeGreaterThan(0);
      tracer.destroy();
    });
  });

  describe("case insensitivity", () => {
    it("redacts keys regardless of case", () => {
      const { tracer, events } = createTracer({ level: "smart" });
      tracer.send(
        "bridge",
        "msg",
        {
          Authorization: "Bearer xyz",
          PASSWORD: "secret",
          Token: "abc",
        },
        { traceId: "t_1" },
      );
      const body = events()[0].body as Record<string, unknown>;
      expect(body.Authorization).toBe("[REDACTED]");
      expect(body.PASSWORD).toBe("[REDACTED]");
      expect(body.Token).toBe("[REDACTED]");
      tracer.destroy();
    });
  });

  describe("redaction in arrays", () => {
    it("redacts sensitive keys inside array elements", () => {
      const { tracer, events } = createTracer({ level: "smart" });
      tracer.send(
        "bridge",
        "msg",
        { items: [{ token: "secret1" }, { password: "secret2" }] },
        { traceId: "t_1" },
      );
      const body = events()[0].body as Record<string, unknown>;
      const items = body.items as Record<string, unknown>[];
      expect(items[0].token).toBe("[REDACTED]");
      expect(items[1].password).toBe("[REDACTED]");
      tracer.destroy();
    });
  });

  describe("full level redaction in translate", () => {
    it("redacts from/to bodies in full mode without allowSensitive", () => {
      const { tracer, events } = createTracer({
        level: "full",
        allowSensitive: false,
      });
      tracer.translate(
        "fn",
        "T1",
        { format: "A", body: { api_key: "key123", data: "ok" } },
        { format: "B", body: { password: "pass456", data: "ok" } },
        { traceId: "t_1" },
      );
      const e = events()[0];
      expect((e.from!.body as Record<string, unknown>).api_key).toBe("[REDACTED]");
      expect((e.to!.body as Record<string, unknown>).password).toBe("[REDACTED]");
      expect((e.from!.body as Record<string, unknown>).data).toBe("ok");
      tracer.destroy();
    });
  });
});
