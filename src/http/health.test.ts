import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { handleHealth } from "./health.js";

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

  it('returns { status: "ok" } body', () => {
    const res = mockResponse();
    handleHealth({} as IncomingMessage, res);

    expect(res.end).toHaveBeenCalledWith(JSON.stringify({ status: "ok" }));
  });
});
