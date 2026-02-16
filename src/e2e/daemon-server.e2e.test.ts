import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { NodeWebSocketServer } from "../adapters/node-ws-server.js";
import { Daemon } from "../daemon/daemon.js";
import { readState } from "../daemon/state-file.js";

describe("E2E: Daemon + server full lifecycle", () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "beamcode-e2e-"));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it("daemon start → server listen → consumer connect → daemon stop → cleanup", async () => {
    const daemon = new Daemon();
    const { controlApiToken } = await daemon.start({ dataDir });

    expect(daemon.isRunning()).toBe(true);
    expect(controlApiToken).toHaveLength(64);

    // Start WebSocket server
    const server = new NodeWebSocketServer({ port: 0 });
    const sessionId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const receivedMessages: string[] = [];

    await server.listen(
      // CLI connection handler
      (socket, sid) => {
        expect(sid).toBe(sessionId);
        socket.send("hello from CLI");
      },
      // Consumer connection handler
      (socket, context) => {
        expect(context.sessionId).toBe(sessionId);
        socket.on("message", (data) => {
          receivedMessages.push(String(data));
        });
        socket.send("hello from server");
      },
    );

    const port = server.port!;
    expect(port).toBeGreaterThan(0);

    // Connect a consumer WebSocket
    const consumerMsg = await new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/consumer/${sessionId}`);
      ws.on("message", (data) => resolve(String(data)));
      ws.on("error", reject);
    });
    expect(consumerMsg).toBe("hello from server");

    // Stop server and daemon
    await server.close();
    await daemon.stop();

    expect(daemon.isRunning()).toBe(false);

    // Lock file cleaned up
    await expect(stat(join(dataDir, "daemon.lock"))).rejects.toThrow();

    // State file cleaned up
    const state = await readState(join(dataDir, "daemon.json"));
    expect(state).toBeNull();

    // New connections should fail
    await expect(
      new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/consumer/${sessionId}`);
        ws.on("open", () => resolve());
        ws.on("error", reject);
      }),
    ).rejects.toThrow();
  });

  it("control API token authentication", async () => {
    const daemon = new Daemon();
    const { controlApiToken } = await daemon.start({ dataDir });

    // Verify token is in state file
    const state = await readState(join(dataDir, "daemon.json"));
    expect(state).not.toBeNull();
    expect(state!.controlApiToken).toBe(controlApiToken);
    expect(state!.controlApiToken).toMatch(/^[0-9a-f]{64}$/);

    // Use the ControlApi to test token-based auth
    const { ControlApi } = await import("../daemon/control-api.js");
    const { ChildProcessSupervisor } = await import("../daemon/child-process-supervisor.js");

    const supervisor = new ChildProcessSupervisor({
      processManager: {
        spawn: () => ({
          pid: 1,
          exited: new Promise(() => {}),
          kill: () => {},
          stdout: null,
          stderr: null,
        }),
        isAlive: () => false,
      },
    });

    const api = new ControlApi({ supervisor, token: controlApiToken });
    const apiPort = await api.listen();

    // Correct token → accepted
    const goodRes = await fetch(`http://127.0.0.1:${apiPort}/health`, {
      headers: { Authorization: `Bearer ${controlApiToken}` },
    });
    expect(goodRes.status).toBe(200);
    const body = (await goodRes.json()) as Record<string, unknown>;
    expect(body.status).toBe("ok");

    // Wrong token → rejected
    const badRes = await fetch(`http://127.0.0.1:${apiPort}/health`, {
      headers: { Authorization: "Bearer wrong-token" },
    });
    expect(badRes.status).toBe(401);

    // Missing token → rejected
    const noAuthRes = await fetch(`http://127.0.0.1:${apiPort}/health`);
    expect(noAuthRes.status).toBe(401);

    await api.close();
    await daemon.stop();
  });

  it("graceful shutdown with active connections", async () => {
    const daemon = new Daemon();
    await daemon.start({ dataDir });

    const server = new NodeWebSocketServer({ port: 0 });
    const sessionId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

    await server.listen(
      () => {},
      (socket) => {
        socket.send("connected");
      },
    );

    const port = server.port!;

    // Connect 3 consumer WebSockets
    const closeCodes: number[] = [];

    const connectConsumer = (): Promise<WebSocket> =>
      new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/consumer/${sessionId}`);
        ws.on("open", () => resolve(ws));
        ws.on("error", reject);
      });

    const consumers = await Promise.all([connectConsumer(), connectConsumer(), connectConsumer()]);
    expect(consumers).toHaveLength(3);

    // Track close events
    const closePromises = consumers.map(
      (ws) =>
        new Promise<number>((resolve) => {
          ws.on("close", (code) => {
            closeCodes.push(code);
            resolve(code);
          });
        }),
    );

    // Graceful shutdown
    await server.close();
    await daemon.stop();

    // All 3 connections should receive close frame with code 1001
    const codes = await Promise.all(closePromises);
    expect(codes).toHaveLength(3);
    for (const code of codes) {
      expect(code).toBe(1001);
    }
    expect(closeCodes).toHaveLength(3);
  });

  it("state file reflects running state", async () => {
    const daemon = new Daemon();
    await daemon.start({ dataDir, port: 5555 });

    // State file should exist with correct content
    const state = await readState(join(dataDir, "daemon.json"));
    expect(state).not.toBeNull();
    expect(state!.pid).toBe(process.pid);
    expect(state!.port).toBe(5555);
    expect(state!.heartbeat).toBeGreaterThan(0);
    expect(state!.heartbeat).toBeLessThanOrEqual(Date.now());
    expect(state!.version).toBe("0.1.0");
    expect(state!.controlApiToken).toMatch(/^[0-9a-f]{64}$/);

    // Stop daemon → state file should be gone
    await daemon.stop();
    const stateAfter = await readState(join(dataDir, "daemon.json"));
    expect(stateAfter).toBeNull();
  });
});
