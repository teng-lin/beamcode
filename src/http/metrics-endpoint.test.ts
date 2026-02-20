import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { handleMetrics } from "./metrics-endpoint.js";

function mockResponse(): ServerResponse {
  return {
    writeHead: vi.fn(),
    end: vi.fn(),
  } as unknown as ServerResponse;
}

describe("handleMetrics", () => {
  it("returns 200 with Prometheus content type", async () => {
    const res = mockResponse();
    const collector = {
      getMetricsOutput: vi.fn().mockResolvedValue("# HELP test\ntest_total 1\n"),
    };

    await handleMetrics({} as IncomingMessage, res, collector as any);

    expect(res.writeHead).toHaveBeenCalledWith(200, {
      "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
    });
    expect(res.end).toHaveBeenCalledWith("# HELP test\ntest_total 1\n");
  });
});
