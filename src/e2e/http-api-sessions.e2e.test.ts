import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryStorage } from "../adapters/memory-storage.js";
import { NodeProcessManager } from "../adapters/node-process-manager.js";
import { NodeWebSocketServer } from "../adapters/node-ws-server.js";
import { SessionManager } from "../core/session-manager.js";
import { createBeamcodeServer } from "../http/server.js";

describe("E2E: HTTP API /api/sessions", () => {
  let server: ReturnType<typeof createBeamcodeServer>;
  let sessionManager: SessionManager;
  let baseUrl: string;
  const apiKey = `test-api-key-${randomBytes(8).toString("hex")}`;

  beforeEach(async () => {
    // Setup SessionManager with real components but in-memory storage
    sessionManager = new SessionManager({
      config: { port: 0 },
      processManager: new NodeProcessManager(),
      storage: new MemoryStorage(),
      server: new NodeWebSocketServer({ port: 0 }),
    });
    await sessionManager.start();

    // Create HTTP server
    server = createBeamcodeServer({
      sessionManager,
      activeSessionId: "placeholder",
      apiKey,
    });

    // Start HTTP server on random port
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
    const res = await fetch(`${baseUrl}/api/sessions`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    expect(res.status).toBe(200);
    const data = (await res.json()) as unknown[];
    expect(Array.isArray(data)).toBe(true);
    expect(data).toHaveLength(0);
  });

  it("POST /api/sessions creates new session and returns sessionId", async () => {
    const res = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ cwd: process.cwd() }),
    });

    expect(res.status).toBe(201);
    const data = (await res.json()) as { sessionId: string; cwd: string };
    expect(data).toHaveProperty("sessionId");
    expect(data.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(data.cwd).toBe(process.cwd());
  });

  it("GET /api/sessions lists all created sessions", async () => {
    // Create 2 sessions
    const res1 = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const session1 = (await res1.json()) as { sessionId: string };

    const res2 = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const session2 = (await res2.json()) as { sessionId: string };

    // List all sessions
    const listRes = await fetch(`${baseUrl}/api/sessions`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const data = (await listRes.json()) as Array<{ sessionId: string }>;

    expect(data).toHaveLength(2);
    expect(data.some((s) => s.sessionId === session1.sessionId)).toBe(true);
    expect(data.some((s) => s.sessionId === session2.sessionId)).toBe(true);
  });

  it("GET /api/sessions/:id returns session info", async () => {
    const createRes = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ cwd: process.cwd(), model: "claude-sonnet-4-5-20250929" }),
    });
    const { sessionId } = (await createRes.json()) as { sessionId: string };

    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    expect(res.status).toBe(200);
    const data = (await res.json()) as { sessionId: string; cwd: string; model?: string };
    expect(data.sessionId).toBe(sessionId);
    expect(data.cwd).toBe(process.cwd());
  });

  it("GET /api/sessions/:id returns 404 for non-existent session", async () => {
    const fakeId = "00000000-0000-0000-0000-000000000000";
    const res = await fetch(`${baseUrl}/api/sessions/${fakeId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    expect(res.status).toBe(404);
    const data = (await res.json()) as { error: string };
    expect(data.error).toBe("Session not found");
  });

  it("DELETE /api/sessions/:id stops session", async () => {
    const createRes = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const { sessionId } = (await createRes.json()) as { sessionId: string };

    const deleteRes = await fetch(`${baseUrl}/api/sessions/${sessionId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    expect(deleteRes.status).toBe(200);
    const data = (await deleteRes.json()) as { status: string };
    expect(data.status).toBe("stopped");

    // Verify session is marked as exited
    const listRes = await fetch(`${baseUrl}/api/sessions`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const sessions = (await listRes.json()) as Array<{ sessionId: string; state: string }>;
    const stoppedSession = sessions.find((s) => s.sessionId === sessionId);
    expect(stoppedSession).toBeDefined();
    expect(stoppedSession?.state).toBe("exited");
  });

  it("rejects API requests without valid API key", async () => {
    // No auth header
    const res1 = await fetch(`${baseUrl}/api/sessions`);
    expect(res1.status).toBe(401);

    // Wrong API key
    const res2 = await fetch(`${baseUrl}/api/sessions`, {
      headers: { Authorization: "Bearer wrong-key" },
    });
    expect(res2.status).toBe(401);
  });

  it("rejects POST /api/sessions with invalid cwd", async () => {
    const res = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ cwd: "/nonexistent/directory/path" }),
    });

    expect(res.status).toBe(400);
    const data = (await res.json()) as { error: string };
    expect(data.error).toContain("Invalid cwd");
  });

  it("rejects POST with request body larger than 1MB", async () => {
    const largeBody = "x".repeat(1024 * 1024 + 1);

    // The server closes the connection when body is too large,
    // which causes a fetch error. This is expected behavior.
    await expect(
      fetch(`${baseUrl}/api/sessions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: largeBody,
      }),
    ).rejects.toThrow();
  });

  it("POST /api/sessions with empty body uses defaults", async () => {
    const res = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    expect(res.status).toBe(201);
    const data = (await res.json()) as { sessionId: string; cwd: string };
    expect(data.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    // cwd should default to server's cwd or user's home
    expect(data.cwd).toBeTruthy();
  });

  it("allows health endpoint access without API key", async () => {
    // Health endpoint should be accessible without auth
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { status: string };
    expect(data.status).toBe("ok");
  });

  it("returns 405 Method Not Allowed for invalid HTTP methods", async () => {
    // Use PUT on a specific session endpoint (not the list endpoint)
    // The list endpoint (/api/sessions) doesn't match the pattern when no sessionId
    const res = await fetch(`${baseUrl}/api/sessions/test-id`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    expect(res.status).toBe(405);
  });
});
