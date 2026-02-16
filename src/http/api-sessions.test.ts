import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";

vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => true),
  statSync: vi.fn(() => ({ isDirectory: () => true })),
}));

import { existsSync, statSync } from "node:fs";
import type { SessionManager } from "../core/session-manager.js";
import { handleApiSessions } from "./api-sessions.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockReq(method: string): IncomingMessage {
  const emitter = new EventEmitter() as IncomingMessage & EventEmitter;
  (emitter as unknown as Record<string, unknown>).method = method;
  (emitter as unknown as Record<string, unknown>).destroy = vi.fn();
  return emitter as IncomingMessage;
}

function mockRes(): ServerResponse & {
  _status: number | null;
  _headers: Record<string, unknown>;
  _body: string;
} {
  const res = {
    _status: null as number | null,
    _headers: {} as Record<string, unknown>,
    _body: "",
    writeHead: vi.fn(function (
      this: typeof res,
      status: number,
      headers?: Record<string, unknown>,
    ) {
      this._status = status;
      if (headers) Object.assign(this._headers, headers);
    }),
    end: vi.fn(function (this: typeof res, body?: string) {
      if (body) this._body = body;
    }),
  };
  return res as unknown as typeof res;
}

function makeUrl(path: string): URL {
  return new URL(path, "http://localhost");
}

function mockSessionManager(
  overrides: Partial<{
    listSessions: () => unknown[];
    getSession: (id: string) => unknown;
    launch: (opts: unknown) => unknown;
    kill: (id: string) => Promise<boolean>;
  }> = {},
): SessionManager {
  return {
    launcher: {
      listSessions: vi.fn(overrides.listSessions ?? (() => [])),
      getSession: vi.fn(overrides.getSession ?? (() => undefined)),
      launch: vi.fn(overrides.launch ?? (() => ({ sessionId: "new-id", status: "running" }))),
      kill: vi.fn(overrides.kill ?? (async () => true)),
    },
  } as unknown as SessionManager;
}

function parseBody(res: ReturnType<typeof mockRes>): unknown {
  return JSON.parse(res._body);
}

// Emit body chunks then end on a mock request.
function emitBody(req: IncomingMessage, body: string): void {
  // Use queueMicrotask so the handler can attach listeners first
  queueMicrotask(() => {
    (req as unknown as EventEmitter).emit("data", Buffer.from(body));
    (req as unknown as EventEmitter).emit("end");
  });
}

function emitEmptyBody(req: IncomingMessage): void {
  queueMicrotask(() => {
    (req as unknown as EventEmitter).emit("end");
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("handleApiSessions", () => {
  // ---- GET /api/sessions ----

  it("GET /api/sessions lists all sessions", () => {
    const sessions = [{ sessionId: "s1" }, { sessionId: "s2" }];
    const sm = mockSessionManager({ listSessions: () => sessions });
    const req = mockReq("GET");
    const res = mockRes();

    handleApiSessions(req, res, makeUrl("/api/sessions"), sm);

    expect(res._status).toBe(200);
    expect(parseBody(res)).toEqual(sessions);
  });

  // ---- POST /api/sessions ----

  it("POST /api/sessions with valid JSON creates a session", async () => {
    const launched = { sessionId: "new-1", status: "running" };
    const sm = mockSessionManager({ launch: () => launched });
    const req = mockReq("POST");
    const res = mockRes();

    handleApiSessions(req, res, makeUrl("/api/sessions"), sm);
    emitBody(req, JSON.stringify({ cwd: "/tmp", model: "opus" }));

    // Wait for async resolution
    await vi.waitFor(() => {
      expect(res._status).toBe(201);
    });
    expect(parseBody(res)).toEqual(launched);
    expect(sm.launcher.launch).toHaveBeenCalledWith({ cwd: "/tmp", model: "opus" });
  });

  it("POST /api/sessions with empty body creates a session with defaults", async () => {
    const launched = { sessionId: "new-2", status: "running" };
    const sm = mockSessionManager({ launch: () => launched });
    const req = mockReq("POST");
    const res = mockRes();

    handleApiSessions(req, res, makeUrl("/api/sessions"), sm);
    emitEmptyBody(req);

    await vi.waitFor(() => {
      expect(res._status).toBe(201);
    });
    expect(sm.launcher.launch).toHaveBeenCalledWith({
      cwd: undefined,
      model: undefined,
    });
  });

  it("POST /api/sessions with invalid JSON returns 400", async () => {
    const sm = mockSessionManager();
    const req = mockReq("POST");
    const res = mockRes();

    handleApiSessions(req, res, makeUrl("/api/sessions"), sm);
    emitBody(req, "not-valid-json{{{");

    await vi.waitFor(() => {
      expect(res._status).toBe(400);
    });
    expect(parseBody(res)).toEqual({ error: "Invalid JSON" });
  });

  it("POST /api/sessions with invalid cwd returns 400", async () => {
    vi.mocked(existsSync).mockReturnValueOnce(false);
    const sm = mockSessionManager();
    const req = mockReq("POST");
    const res = mockRes();

    handleApiSessions(req, res, makeUrl("/api/sessions"), sm);
    emitBody(req, JSON.stringify({ cwd: "/nonexistent" }));

    await vi.waitFor(() => {
      expect(res._status).toBe(400);
    });
    expect(parseBody(res)).toEqual({ error: "Invalid cwd: not an existing directory" });
  });

  it("POST /api/sessions with cwd that is not a directory returns 400", async () => {
    vi.mocked(existsSync).mockReturnValueOnce(true);
    vi.mocked(statSync).mockReturnValueOnce({ isDirectory: () => false } as ReturnType<
      typeof statSync
    >);
    const sm = mockSessionManager();
    const req = mockReq("POST");
    const res = mockRes();

    handleApiSessions(req, res, makeUrl("/api/sessions"), sm);
    emitBody(req, JSON.stringify({ cwd: "/some/file.txt" }));

    await vi.waitFor(() => {
      expect(res._status).toBe(400);
    });
    expect(parseBody(res)).toEqual({ error: "Invalid cwd: not an existing directory" });
  });

  it("POST /api/sessions with body too large returns 413", async () => {
    const sm = mockSessionManager();
    const req = mockReq("POST");
    const res = mockRes();

    handleApiSessions(req, res, makeUrl("/api/sessions"), sm);

    // Emit a chunk larger than 1 MB
    const bigChunk = Buffer.alloc(1024 * 1024 + 1, "x");
    queueMicrotask(() => {
      (req as unknown as EventEmitter).emit("data", bigChunk);
    });

    await vi.waitFor(() => {
      expect(res._status).toBe(413);
    });
    expect(parseBody(res)).toEqual({ error: "Request body too large" });
  });

  // ---- GET /api/sessions/:id ----

  it("GET /api/sessions/:id returns session when found", () => {
    const session = { sessionId: "abc", status: "running" };
    const sm = mockSessionManager({ getSession: () => session });
    const req = mockReq("GET");
    const res = mockRes();

    handleApiSessions(req, res, makeUrl("/api/sessions/abc"), sm);

    expect(res._status).toBe(200);
    expect(parseBody(res)).toEqual(session);
  });

  it("GET /api/sessions/:id returns 404 when not found", () => {
    const sm = mockSessionManager({ getSession: () => undefined });
    const req = mockReq("GET");
    const res = mockRes();

    handleApiSessions(req, res, makeUrl("/api/sessions/nonexistent"), sm);

    expect(res._status).toBe(404);
    expect(parseBody(res)).toEqual({ error: "Session not found" });
  });

  // ---- DELETE /api/sessions/:id ----

  it("DELETE /api/sessions/:id returns success when killed", async () => {
    const sm = mockSessionManager({ kill: async () => true });
    const req = mockReq("DELETE");
    const res = mockRes();

    handleApiSessions(req, res, makeUrl("/api/sessions/abc"), sm);

    await vi.waitFor(() => {
      expect(res._status).toBe(200);
    });
    expect(parseBody(res)).toEqual({ status: "stopped" });
  });

  it("DELETE /api/sessions/:id returns 404 when session not found", async () => {
    const sm = mockSessionManager({ kill: async () => false });
    const req = mockReq("DELETE");
    const res = mockRes();

    handleApiSessions(req, res, makeUrl("/api/sessions/abc"), sm);

    await vi.waitFor(() => {
      expect(res._status).toBe(404);
    });
    expect(parseBody(res)).toEqual({ error: "Session not found" });
  });

  it("DELETE /api/sessions/:id returns 500 on error", async () => {
    const sm = mockSessionManager({
      kill: async () => {
        throw new Error("Kill failed");
      },
    });
    const req = mockReq("DELETE");
    const res = mockRes();

    handleApiSessions(req, res, makeUrl("/api/sessions/abc"), sm);

    await vi.waitFor(() => {
      expect(res._status).toBe(500);
    });
    expect(parseBody(res)).toEqual({ error: "Kill failed" });
  });

  // ---- Unknown method ----

  it("returns 405 for unsupported method on /api/sessions/:id", () => {
    const sm = mockSessionManager();
    const req = mockReq("PATCH");
    const res = mockRes();

    handleApiSessions(req, res, makeUrl("/api/sessions/abc"), sm);

    expect(res._status).toBe(405);
    expect(parseBody(res)).toEqual({ error: "Method not allowed" });
  });

  // ---- Missing session ID with more than 2 segments ----

  it("returns 404 when segments > 2 but sessionId is empty", () => {
    const sm = mockSessionManager();
    const req = mockReq("GET");
    const res = mockRes();

    // /api/sessions/ has 2 segments after filtering, same as /api/sessions
    // But with PATCH method and 2 segments it falls through:
    // segments.length === 2, method === "PATCH" => falls through to sessionId check
    // segments[2] is undefined => 404
    const reqPatch = mockReq("PATCH");
    const resPatch = mockRes();
    handleApiSessions(reqPatch, resPatch, makeUrl("/api/sessions"), sm);

    expect(resPatch._status).toBe(404);
    expect(parseBody(resPatch)).toEqual({ error: "Not found" });
  });
});
