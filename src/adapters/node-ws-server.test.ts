import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import type { AuthContext } from "../interfaces/auth.js";
import { OriginValidator } from "../server/origin-validator.js";
import { NodeWebSocketServer } from "./node-ws-server.js";

let server: NodeWebSocketServer | null = null;

// Valid UUIDs for testing
const TEST_UUID_1 = "550e8400-e29b-41d4-a716-446655440000";
const TEST_UUID_2 = "550e8400-e29b-41d4-a716-446655440001";
const TEST_UUID_3 = "550e8400-e29b-41d4-a716-446655440002";

afterEach(async () => {
  if (server) {
    await server.close();
    server = null;
  }
});

describe("NodeWebSocketServer", () => {
  it("accepts CLI connections and extracts sessionId", async () => {
    server = new NodeWebSocketServer({ port: 0 });
    const connections: { sessionId: string; messages: string[] }[] = [];

    await server.listen((socket, sessionId) => {
      const entry = { sessionId, messages: [] as string[] };
      connections.push(entry);
      socket.on("message", (data) => {
        entry.messages.push(typeof data === "string" ? data : data.toString("utf-8"));
      });
    });

    const port = server.port!;
    const ws = new WebSocket(`ws://localhost:${port}/ws/cli/${TEST_UUID_1}`);
    await new Promise<void>((resolve, reject) => {
      ws.on("open", resolve);
      ws.on("error", reject);
    });

    ws.send("hello");
    await new Promise((r) => setTimeout(r, 50));

    expect(connections).toHaveLength(1);
    expect(connections[0].sessionId).toBe(TEST_UUID_1);
    expect(connections[0].messages).toContain("hello");

    ws.close();
  });

  it("rejects connections without valid path", async () => {
    server = new NodeWebSocketServer({ port: 0 });
    await server.listen(() => {});

    const port = server.port!;
    const ws = new WebSocket(`ws://localhost:${port}/invalid`);
    const code = await new Promise<number>((resolve) => {
      ws.on("close", (code) => resolve(code));
    });

    expect(code).not.toBe(1000);
  });

  it("sends data back to CLI via socket.send()", async () => {
    server = new NodeWebSocketServer({ port: 0 });
    const received: string[] = [];

    await server.listen((socket, _sessionId) => {
      socket.send(JSON.stringify({ type: "greeting" }));
    });

    const port = server.port!;
    const ws = new WebSocket(`ws://localhost:${port}/ws/cli/${TEST_UUID_2}`);
    ws.on("message", (data) => received.push(data.toString()));
    await new Promise<void>((resolve) => {
      ws.on("open", resolve);
    });
    await new Promise((r) => setTimeout(r, 50));

    expect(received).toHaveLength(1);
    expect(JSON.parse(received[0])).toEqual({ type: "greeting" });

    ws.close();
  });

  it("close() shuts down the server", async () => {
    server = new NodeWebSocketServer({ port: 0 });
    await server.listen(() => {});

    const port = server.port!;
    await server.close();
    server = null;

    const ws = new WebSocket(`ws://localhost:${port}/ws/cli/x`);
    const error = await new Promise<Error>((resolve) => {
      ws.on("error", resolve);
    });
    expect(error).toBeTruthy();
  });

  // ── Consumer path tests ─────────────────────────────────────────────

  it("accepts consumer connections on /ws/consumer/:sessionId", async () => {
    server = new NodeWebSocketServer({ port: 0 });
    const contexts: AuthContext[] = [];

    await server.listen(
      () => {},
      (socket, context) => {
        contexts.push(context);
        socket.send(JSON.stringify({ type: "hello" }));
      },
    );

    const port = server.port!;
    const ws = new WebSocket(`ws://localhost:${port}/ws/consumer/${TEST_UUID_1}`);
    const received: string[] = [];
    ws.on("message", (data) => received.push(data.toString()));
    await new Promise<void>((resolve, reject) => {
      ws.on("open", resolve);
      ws.on("error", reject);
    });
    await new Promise((r) => setTimeout(r, 50));

    expect(contexts).toHaveLength(1);
    expect(contexts[0].sessionId).toBe(TEST_UUID_1);
    expect(received).toHaveLength(1);

    ws.close();
  });

  it("AuthContext includes headers, query params, remoteAddress", async () => {
    server = new NodeWebSocketServer({ port: 0 });
    const contexts: AuthContext[] = [];

    await server.listen(
      () => {},
      (_socket, context) => {
        contexts.push(context);
      },
    );

    const port = server.port!;
    const ws = new WebSocket(`ws://localhost:${port}/ws/consumer/${TEST_UUID_2}?token=abc`, {
      headers: { "x-custom": "test-val" },
    });
    await new Promise<void>((resolve, reject) => {
      ws.on("open", resolve);
      ws.on("error", reject);
    });
    await new Promise((r) => setTimeout(r, 50));

    expect(contexts).toHaveLength(1);
    expect(contexts[0].sessionId).toBe(TEST_UUID_2);
    const transport = contexts[0].transport as Record<string, any>;
    expect(transport.query).toEqual(expect.objectContaining({ token: "abc" }));
    expect(transport.headers).toEqual(expect.objectContaining({ "x-custom": "test-val" }));
    expect(transport.remoteAddress).toBeDefined();

    ws.close();
  });

  it("consumer handler is optional (backward compatible)", async () => {
    server = new NodeWebSocketServer({ port: 0 });

    // Only provide CLI callback (no consumer callback)
    await server.listen(() => {});

    const port = server.port!;
    const ws = new WebSocket(`ws://localhost:${port}/ws/consumer/${TEST_UUID_3}`);
    const code = await new Promise<number>((resolve) => {
      ws.on("close", (code) => resolve(code));
    });

    // Without consumer handler, should close with 4000
    expect(code).toBe(4000);
  });

  // ── Origin validation tests ─────────────────────────────────────────

  it("rejects connections from untrusted origins when originValidator is set", async () => {
    const originValidator = new OriginValidator();
    server = new NodeWebSocketServer({ port: 0, originValidator });
    await server.listen(() => {});

    const port = server.port!;
    const ws = new WebSocket(`ws://localhost:${port}/ws/cli/${TEST_UUID_1}`, {
      headers: { origin: "https://evil.com" },
    });

    const result = await new Promise<"error" | "open">((resolve) => {
      ws.on("open", () => resolve("open"));
      ws.on("error", () => resolve("error"));
      ws.on("unexpected-response", () => resolve("error"));
    });

    expect(result).toBe("error");
    ws.close();
  });

  it("accepts connections from localhost origins when originValidator is set", async () => {
    const originValidator = new OriginValidator();
    server = new NodeWebSocketServer({ port: 0, originValidator });
    await server.listen(() => {});

    const port = server.port!;
    const ws = new WebSocket(`ws://localhost:${port}/ws/cli/${TEST_UUID_2}`, {
      headers: { origin: "http://localhost:3000" },
    });

    await new Promise<void>((resolve, reject) => {
      ws.on("open", resolve);
      ws.on("error", reject);
    });

    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it("accepts connections without origin header when originValidator allows missing", async () => {
    const originValidator = new OriginValidator();
    server = new NodeWebSocketServer({ port: 0, originValidator });
    await server.listen(() => {});

    const port = server.port!;
    // No origin header set (default behavior for programmatic clients)
    const ws = new WebSocket(`ws://localhost:${port}/ws/cli/${TEST_UUID_3}`);

    await new Promise<void>((resolve, reject) => {
      ws.on("open", resolve);
      ws.on("error", reject);
    });

    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });
});
