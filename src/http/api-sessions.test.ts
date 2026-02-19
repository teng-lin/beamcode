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
    bridgeGetAllSessions: () => Array<{ session_id: string }>;
    bridgeGetSession: (id: string) => unknown;
    launch: (opts: unknown) => unknown;
    kill: (id: string) => Promise<boolean>;
    deleteSession: (id: string) => Promise<boolean>;
    createSession: (opts: unknown) => Promise<unknown>;
  }> = {},
): SessionManager {
  return {
    deleteSession: vi.fn(overrides.deleteSession ?? (async () => true)),
    createSession: vi.fn(
      overrides.createSession ??
        (async () => ({
          sessionId: "new-id",
          cwd: process.cwd(),
          adapterName: "claude",
          state: "starting",
          createdAt: Date.now(),
        })),
    ),
    launcher: {
      listSessions: vi.fn(overrides.listSessions ?? (() => [])),
      getSession: vi.fn(overrides.getSession ?? (() => undefined)),
      launch: vi.fn(overrides.launch ?? (() => ({ sessionId: "new-id", status: "running" }))),
      kill: vi.fn(overrides.kill ?? (async () => true)),
      setSessionName: vi.fn(),
      setArchived: vi.fn(),
      removeSession: vi.fn(),
    },
    bridge: {
      broadcastNameUpdate: vi.fn(),
      seedSessionState: vi.fn(),
      getAllSessions: vi.fn(overrides.bridgeGetAllSessions ?? (() => [])),
      getSession: vi.fn(overrides.bridgeGetSession ?? (() => undefined)),
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

  it("GET /api/sessions includes bridge-only sessions", () => {
    const sm = mockSessionManager({
      listSessions: () => [],
      bridgeGetAllSessions: () => [{ session_id: "bridge-1" }],
      bridgeGetSession: () => ({
        id: "bridge-1",
        cliConnected: true,
        lastActivity: 123,
        state: {
          cwd: "/tmp",
          model: "m1",
          permissionMode: "default",
          session_id: "backend-1",
        },
      }),
    });
    const req = mockReq("GET");
    const res = mockRes();

    handleApiSessions(req, res, makeUrl("/api/sessions"), sm);

    expect(res._status).toBe(200);
    expect(parseBody(res)).toEqual([
      {
        sessionId: "bridge-1",
        state: "connected",
        cwd: "/tmp",
        model: "m1",
        permissionMode: "default",
        cliSessionId: "backend-1",
        createdAt: 123,
      },
    ]);
  });

  // ---- POST /api/sessions ----

  it("POST /api/sessions with valid JSON creates a session", async () => {
    const created = {
      sessionId: "new-1",
      cwd: "/tmp",
      adapterName: "claude",
      state: "starting",
      createdAt: 1000,
    };
    const sm = mockSessionManager({ createSession: async () => created });
    const req = mockReq("POST");
    const res = mockRes();

    handleApiSessions(req, res, makeUrl("/api/sessions"), sm);
    emitBody(req, JSON.stringify({ cwd: "/tmp", model: "opus" }));

    await vi.waitFor(() => {
      expect(res._status).toBe(201);
    });
    expect(parseBody(res)).toEqual(created);
    expect(sm.createSession).toHaveBeenCalledWith({
      cwd: "/tmp",
      model: "opus",
      adapterName: undefined,
    });
  });

  it("POST /api/sessions with empty body creates a session with defaults", async () => {
    const sm = mockSessionManager();
    const req = mockReq("POST");
    const res = mockRes();

    handleApiSessions(req, res, makeUrl("/api/sessions"), sm);
    emitEmptyBody(req);

    await vi.waitFor(() => {
      expect(res._status).toBe(201);
    });
    expect(sm.createSession).toHaveBeenCalledWith({
      cwd: undefined,
      model: undefined,
      adapterName: undefined,
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

  it("GET /api/sessions/:id falls back to bridge snapshot when launcher misses", () => {
    const sm = mockSessionManager({
      getSession: () => undefined,
      bridgeGetSession: () => ({
        id: "abc",
        cliConnected: false,
        lastActivity: 456,
        state: {
          cwd: "/repo",
          model: "",
          permissionMode: "default",
          session_id: "backend-2",
        },
      }),
    });
    const req = mockReq("GET");
    const res = mockRes();

    handleApiSessions(req, res, makeUrl("/api/sessions/abc"), sm);

    expect(res._status).toBe(200);
    expect(parseBody(res)).toEqual({
      sessionId: "abc",
      state: "starting",
      cwd: "/repo",
      permissionMode: "default",
      cliSessionId: "backend-2",
      createdAt: 456,
    });
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

  it("DELETE /api/sessions/:id returns deleted status", async () => {
    const sm = mockSessionManager({ deleteSession: async () => true });
    const req = mockReq("DELETE");
    const res = mockRes();

    handleApiSessions(req, res, makeUrl("/api/sessions/abc"), sm);

    await vi.waitFor(() => {
      expect(res._status).toBe(200);
    });
    expect(parseBody(res)).toEqual({ status: "deleted" });
    expect(sm.deleteSession).toHaveBeenCalledWith("abc");
  });

  it("DELETE /api/sessions/:id returns 404 when session not found", async () => {
    const sm = mockSessionManager({ deleteSession: async () => false });
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
      deleteSession: async () => {
        throw new Error("Delete failed");
      },
    });
    const req = mockReq("DELETE");
    const res = mockRes();

    handleApiSessions(req, res, makeUrl("/api/sessions/abc"), sm);

    await vi.waitFor(() => {
      expect(res._status).toBe(500);
    });
    expect(parseBody(res)).toEqual({ error: "Delete failed" });
  });

  // ---- PUT /api/sessions/:id/rename ----

  it("PUT /api/sessions/:id/rename renames a session", async () => {
    const session = { sessionId: "abc", name: "old-name", state: "running" };
    const sm = mockSessionManager({ getSession: () => session });
    const req = mockReq("PUT");
    const res = mockRes();

    handleApiSessions(req, res, makeUrl("/api/sessions/abc/rename"), sm);
    emitBody(req, JSON.stringify({ name: "new-name" }));

    await vi.waitFor(() => {
      expect(res._status).toBe(200);
    });
    expect(parseBody(res)).toEqual({ ...session, name: "new-name" });
    expect(sm.launcher.setSessionName).toHaveBeenCalledWith("abc", "new-name");
    expect(sm.bridge.broadcastNameUpdate).toHaveBeenCalledWith("abc", "new-name");
  });

  it("PUT /api/sessions/:id/rename returns 400 for empty name", async () => {
    const sm = mockSessionManager();
    const req = mockReq("PUT");
    const res = mockRes();

    handleApiSessions(req, res, makeUrl("/api/sessions/abc/rename"), sm);
    emitBody(req, JSON.stringify({ name: "   " }));

    await vi.waitFor(() => {
      expect(res._status).toBe(400);
    });
    expect(parseBody(res)).toEqual({
      error: "name is required and must be a non-empty string",
    });
  });

  it("PUT /api/sessions/:id/rename returns 400 for missing name", async () => {
    const sm = mockSessionManager();
    const req = mockReq("PUT");
    const res = mockRes();

    handleApiSessions(req, res, makeUrl("/api/sessions/abc/rename"), sm);
    emitBody(req, JSON.stringify({}));

    await vi.waitFor(() => {
      expect(res._status).toBe(400);
    });
    expect(parseBody(res)).toEqual({
      error: "name is required and must be a non-empty string",
    });
  });

  it("PUT /api/sessions/:id/rename returns 404 when session not found", async () => {
    const sm = mockSessionManager({ getSession: () => undefined });
    const req = mockReq("PUT");
    const res = mockRes();

    handleApiSessions(req, res, makeUrl("/api/sessions/abc/rename"), sm);
    emitBody(req, JSON.stringify({ name: "new-name" }));

    await vi.waitFor(() => {
      expect(res._status).toBe(404);
    });
    expect(parseBody(res)).toEqual({ error: "Session not found" });
  });

  it("PUT /api/sessions/:id/rename returns 400 for invalid JSON", async () => {
    const sm = mockSessionManager();
    const req = mockReq("PUT");
    const res = mockRes();

    handleApiSessions(req, res, makeUrl("/api/sessions/abc/rename"), sm);
    emitBody(req, "not-json{{{");

    await vi.waitFor(() => {
      expect(res._status).toBe(400);
    });
    expect(parseBody(res)).toEqual({ error: "Invalid JSON" });
  });

  it("PUT /api/sessions/:id/rename trims and truncates name", async () => {
    const session = { sessionId: "abc", name: "old", state: "running" };
    const sm = mockSessionManager({ getSession: () => session });
    const req = mockReq("PUT");
    const res = mockRes();

    const longName = `  ${"a".repeat(120)}  `;
    handleApiSessions(req, res, makeUrl("/api/sessions/abc/rename"), sm);
    emitBody(req, JSON.stringify({ name: longName }));

    await vi.waitFor(() => {
      expect(res._status).toBe(200);
    });
    const body = parseBody(res) as { name: string };
    expect(body.name).toHaveLength(100);
    expect(sm.launcher.setSessionName).toHaveBeenCalledWith("abc", "a".repeat(100));
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

  // ---- Unsupported method on collection ----

  it("returns 404 for unsupported method on /api/sessions (no sessionId)", () => {
    const sm = mockSessionManager();
    const req = mockReq("PATCH");
    const res = mockRes();

    handleApiSessions(req, res, makeUrl("/api/sessions"), sm);

    expect(res._status).toBe(404);
    expect(parseBody(res)).toEqual({ error: "Not found" });
  });
});
