import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import type { ChildProcessSupervisor } from "../daemon/child-process-supervisor.js";
import { extractSessionId, routeSession } from "./session-router.js";

describe("extractSessionId", () => {
  it("extracts session ID from valid path", () => {
    expect(extractSessionId("/ws/consumer/abc-def-123-456")).toBe("abc-def-123-456");
  });

  it("returns null for invalid path", () => {
    expect(extractSessionId("/health")).toBeNull();
    expect(extractSessionId("/ws/cli/abc")).toBeNull();
    expect(extractSessionId("/")).toBeNull();
  });
});

describe("routeSession", () => {
  function makeReq(url: string): IncomingMessage {
    return { url } as IncomingMessage;
  }

  function makeSupervisor(sessions: Record<string, { status: string }>) {
    return {
      getSession(id: string) {
        return sessions[id] as ReturnType<ChildProcessSupervisor["getSession"]>;
      },
    } as ChildProcessSupervisor;
  }

  it("routes valid running session", () => {
    const supervisor = makeSupervisor({
      "abc-123": { status: "running" },
    });
    const result = routeSession(makeReq("/ws/consumer/abc-123"), supervisor);
    expect(result).toEqual({ sessionId: "abc-123" });
  });

  it("returns 400 for invalid path", () => {
    const supervisor = makeSupervisor({});
    const result = routeSession(makeReq("/invalid"), supervisor);
    expect(result).toEqual({
      error: expect.stringContaining("Invalid path"),
      statusCode: 400,
    });
  });

  it("returns 404 for unknown session", () => {
    const supervisor = makeSupervisor({});
    const result = routeSession(makeReq("/ws/consumer/unknown-id"), supervisor);
    expect(result).toEqual({
      error: expect.stringContaining("not found"),
      statusCode: 404,
    });
  });

  it("returns 410 for stopped session", () => {
    const supervisor = makeSupervisor({
      "stopped-1": { status: "stopped" },
    });
    const result = routeSession(makeReq("/ws/consumer/stopped-1"), supervisor);
    expect(result).toEqual({
      error: expect.stringContaining("not running"),
      statusCode: 410,
    });
  });
});
