import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClaudeLauncher } from "../adapters/claude/claude-launcher.js";
import { MemoryStorage } from "../adapters/memory-storage.js";
import { NodeWebSocketServer } from "../adapters/node-ws-server.js";
import { SessionManager } from "../core/session-manager.js";
import { createBeamcodeServer } from "../http/server.js";
import { createProcessManager } from "./helpers/test-utils.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("E2E: HTTP API /api/sessions", () => {
  let server: ReturnType<typeof createBeamcodeServer>;
  let sessionManager: SessionManager;
  let baseUrl: string;
  const apiKey = `test-api-key-${randomBytes(8).toString("hex")}`;

  /** Fetch with the test API key pre-applied. */
  function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (!headers.has("Authorization")) {
      headers.set("Authorization", `Bearer ${apiKey}`);
    }
    return fetch(`${baseUrl}${path}`, { ...init, headers });
  }

  /** POST to /api/sessions with optional JSON body. */
  function createSession(body?: Record<string, unknown>): Promise<Response> {
    if (!body) {
      return apiFetch("/api/sessions", { method: "POST" });
    }
    return apiFetch("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  beforeEach(async () => {
    const storage = new MemoryStorage();
    const processManager = createProcessManager();
    const config = { port: 0 };
    sessionManager = new SessionManager({
      config,
      storage,
      server: new NodeWebSocketServer({ port: 0 }),
      launcher: new ClaudeLauncher({ processManager, config, storage }),
    });
    await sessionManager.start();

    server = createBeamcodeServer({
      sessionManager,
      activeSessionId: "placeholder",
      apiKey,
    });

    await new Promise<void>((resolve) => {
      server.listen(0, () => resolve());
    });

    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://localhost:${port}`;
  });

  afterEach(async () => {
    await sessionManager.stop();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  it("GET /api/sessions returns empty list initially", async () => {
    const res = await apiFetch("/api/sessions");

    expect(res.status).toBe(200);
    const data = (await res.json()) as unknown[];
    expect(Array.isArray(data)).toBe(true);
    expect(data).toHaveLength(0);
  });

  it("POST /api/sessions creates new session and returns sessionId", async () => {
    const res = await createSession({ cwd: process.cwd() });

    expect(res.status).toBe(201);
    const data = (await res.json()) as { sessionId: string; cwd: string };
    expect(data).toHaveProperty("sessionId");
    expect(data.sessionId).toMatch(UUID_PATTERN);
    expect(data.cwd).toBe(process.cwd());
  });

  it("GET /api/sessions lists all created sessions", async () => {
    const res1 = await createSession();
    expect(res1.status).toBe(201);
    const session1 = (await res1.json()) as { sessionId: string };

    const res2 = await createSession();
    expect(res2.status).toBe(201);
    const session2 = (await res2.json()) as { sessionId: string };

    const listRes = await apiFetch("/api/sessions");
    expect(listRes.status).toBe(200);
    const data = (await listRes.json()) as Array<{ sessionId: string }>;

    expect(data).toHaveLength(2);
    const ids = data.map((s) => s.sessionId);
    expect(ids).toContain(session1.sessionId);
    expect(ids).toContain(session2.sessionId);
  });

  it("GET /api/sessions/:id returns session info", async () => {
    const createRes = await createSession({
      cwd: process.cwd(),
      model: "test-model-id",
    });
    const { sessionId } = (await createRes.json()) as { sessionId: string };

    const res = await apiFetch(`/api/sessions/${sessionId}`);

    expect(res.status).toBe(200);
    const data = (await res.json()) as { sessionId: string; cwd: string };
    expect(data.sessionId).toBe(sessionId);
    expect(data.cwd).toBe(process.cwd());
  });

  it("GET /api/sessions/:id returns 404 for non-existent session", async () => {
    const fakeId = "00000000-0000-0000-0000-000000000000";
    const res = await apiFetch(`/api/sessions/${fakeId}`);

    expect(res.status).toBe(404);
    const data = (await res.json()) as { error: string };
    expect(data.error).toBe("Session not found");
  });

  it("DELETE /api/sessions/:id stops session", async () => {
    const createRes = await createSession();
    expect(createRes.status).toBe(201);
    const { sessionId } = (await createRes.json()) as { sessionId: string };

    const deleteRes = await apiFetch(`/api/sessions/${sessionId}`, { method: "DELETE" });

    expect(deleteRes.status).toBe(200);
    const data = (await deleteRes.json()) as { status: string };
    expect(data.status).toBe("deleted");

    // Verify session is removed from the list
    const listRes = await apiFetch("/api/sessions");
    expect(listRes.status).toBe(200);
    const sessions = (await listRes.json()) as Array<{ sessionId: string; state: string }>;
    const deletedSession = sessions.find((s) => s.sessionId === sessionId);
    expect(deletedSession).toBeUndefined();
  });

  it("rejects API requests without valid API key", async () => {
    const noAuth = await fetch(`${baseUrl}/api/sessions`);
    expect(noAuth.status).toBe(401);

    const wrongAuth = await fetch(`${baseUrl}/api/sessions`, {
      headers: { Authorization: "Bearer wrong-key" },
    });
    expect(wrongAuth.status).toBe(401);
  });

  it("rejects POST /api/sessions with invalid cwd", async () => {
    const res = await createSession({ cwd: "/nonexistent/directory/path" });

    expect(res.status).toBe(400);
    const data = (await res.json()) as { error: string };
    expect(data.error).toContain("Invalid cwd");
  });

  it("rejects POST with request body larger than 1MB", async () => {
    const largeBody = "x".repeat(1024 * 1024 + 1);

    // The server closes the connection when body is too large,
    // which causes a fetch error. This is expected behavior.
    await expect(
      apiFetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: largeBody,
      }),
    ).rejects.toThrow(TypeError);
  });

  it("POST /api/sessions with empty body uses defaults", async () => {
    const res = await createSession();

    expect(res.status).toBe(201);
    const data = (await res.json()) as { sessionId: string; cwd: string };
    expect(data.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(data.cwd).toBeTruthy();
  });

  it("rejects health endpoint without API key", async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(401);
  });

  it("allows health endpoint access with valid API key", async () => {
    const res = await apiFetch("/health");
    expect(res.status).toBe(200);
    const data = (await res.json()) as { status: string };
    expect(data.status).toBe("ok");
  });

  it("returns 405 Method Not Allowed for invalid HTTP methods", async () => {
    const res = await apiFetch("/api/sessions/test-id", { method: "PUT" });
    expect(res.status).toBe(405);
  });
});
