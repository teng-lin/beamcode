import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import type { MetricsCollector } from "../interfaces/metrics.js";
import { type HealthContext, handleHealth } from "./health.js";

function mockResponse(): ServerResponse {
  return {
    writeHead: vi.fn(),
    end: vi.fn(),
  } as unknown as ServerResponse;
}

describe("handleHealth", () => {
  it("returns 200 with Content-Type application/json", () => {
    const res = mockResponse();
    handleHealth({} as IncomingMessage, res);

    expect(res.writeHead).toHaveBeenCalledWith(200, {
      "Content-Type": "application/json",
    });
  });

  it('returns { status: "ok" } body without context', () => {
    const res = mockResponse();
    handleHealth({} as IncomingMessage, res);

    expect(res.end).toHaveBeenCalledWith(JSON.stringify({ status: "ok" }));
  });

  it("returns enriched response with HealthContext", () => {
    const res = mockResponse();
    const metrics: MetricsCollector = {
      recordEvent: vi.fn(),
      getStats: vi
        .fn()
        .mockReturnValue({ totalSessions: 3, totalConsumers: 5, backendConnected: 2 }),
      getErrorStats: vi.fn().mockReturnValue({
        counts: { warning: 1, error: 2, critical: 0, total: 3 },
        recentErrors: [],
      }),
    };
    const ctx: HealthContext = { version: "1.2.3", metrics };

    handleHealth({} as IncomingMessage, res, ctx);

    const body = JSON.parse((res.end as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(body.status).toBe("ok");
    expect(body.version).toBe("1.2.3");
    expect(body.uptime_seconds).toBeTypeOf("number");
    expect(body.sessions).toBe(3);
    expect(body.consumers).toBe(5);
    expect(body.errors).toEqual({ warning: 1, error: 2, critical: 0, total: 3 });
  });

  it("handles context without optional methods", () => {
    const res = mockResponse();
    const metrics: MetricsCollector = {
      recordEvent: vi.fn(),
    };
    const ctx: HealthContext = { version: "0.0.1", metrics };

    handleHealth({} as IncomingMessage, res, ctx);

    const body = JSON.parse((res.end as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(body.status).toBe("ok");
    expect(body.version).toBe("0.0.1");
    expect(body.uptime_seconds).toBeTypeOf("number");
    expect(body.sessions).toBeUndefined();
    expect(body.errors).toBeUndefined();
  });
});
