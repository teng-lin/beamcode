import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProcessHandle, ProcessManager, SpawnOptions } from "../interfaces/process-manager.js";
import { ChildProcessSupervisor } from "./child-process-supervisor.js";
import { ControlApi } from "./control-api.js";

class MockProcessManager implements ProcessManager {
  spawn(_options: SpawnOptions): ProcessHandle {
    let resolveExit: (code: number | null) => void;
    const exited = new Promise<number | null>((r) => {
      resolveExit = r;
    });
    return {
      pid: 99999,
      exited,
      kill() {
        resolveExit!(0);
      },
      stdout: null,
      stderr: null,
    };
  }

  isAlive(): boolean {
    return false;
  }
}

const TOKEN = "test-token-abc123";

describe("ControlApi", () => {
  let supervisor: ChildProcessSupervisor;
  let api: ControlApi;
  let port: number;
  let baseUrl: string;

  beforeEach(async () => {
    supervisor = new ChildProcessSupervisor({
      processManager: new MockProcessManager(),
    });
    api = new ControlApi({ supervisor, token: TOKEN, startedAt: Date.now() });
    port = await api.listen();
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await api.close();
  });

  async function request(
    path: string,
    options: RequestInit = {},
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await fetch(`${baseUrl}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        ...options.headers,
      },
    });
    const body = (await res.json()) as Record<string, unknown>;
    return { status: res.status, body };
  }

  // ---- Auth ----

  it("rejects missing token with 401", async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(401);
  });

  it("rejects invalid token with 401", async () => {
    const res = await fetch(`${baseUrl}/health`, {
      headers: { Authorization: "Bearer wrong-token" },
    });
    expect(res.status).toBe(401);
  });

  // ---- GET /health ----

  it("returns health status", async () => {
    const { status, body } = await request("/health");
    expect(status).toBe(200);
    expect(body.status).toBe("ok");
    expect(typeof body.uptime).toBe("number");
    expect(body.sessions).toBe(0);
  });

  // ---- GET /sessions ----

  it("lists sessions (empty)", async () => {
    const { status, body } = await request("/sessions");
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(0);
  });

  // ---- POST /sessions ----

  it("creates a session", async () => {
    const { status, body } = await request("/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/tmp" }),
    });
    expect(status).toBe(201);
    expect(body.sessionId).toBeTruthy();
    expect(body.status).toBe("running");
    expect(body.cwd).toBe("/tmp");
  });

  it("rejects POST without Content-Type", async () => {
    const res = await fetch(`${baseUrl}/sessions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ cwd: "/tmp" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects POST with missing cwd", async () => {
    const { status, body } = await request("/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(status).toBe(400);
    expect(body.error).toContain("cwd");
  });

  it("rejects POST with invalid JSON", async () => {
    const { status } = await request("/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    expect(status).toBe(400);
  });

  // ---- DELETE /sessions/:id ----

  it("deletes a session", async () => {
    const { body: created } = await request("/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/tmp" }),
    });
    const id = created.sessionId as string;

    const { status, body } = await request(`/sessions/${id}`, {
      method: "DELETE",
    });
    expect(status).toBe(200);
    expect(body.status).toBe("stopped");
  });

  it("returns 404 for unknown session delete", async () => {
    const { status } = await request("/sessions/nonexistent", {
      method: "DELETE",
    });
    expect(status).toBe(404);
  });

  // ---- POST /revoke-device ----

  it("returns 501 for revoke-device placeholder", async () => {
    const { status } = await request("/revoke-device", { method: "POST" });
    expect(status).toBe(501);
  });

  // ---- 404 ----

  it("returns 404 for unknown routes", async () => {
    const { status } = await request("/unknown");
    expect(status).toBe(404);
  });
});
