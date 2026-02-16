import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { FileStorage } from "../adapters/file-storage.js";
import { MemoryStorage } from "../adapters/memory-storage.js";
import { NodeProcessManager } from "../adapters/node-process-manager.js";
import { NodeWebSocketServer } from "../adapters/node-ws-server.js";
import { SessionManager } from "../core/session-manager.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function collectMessages(ws: WebSocket, count: number, timeoutMs = 2000): Promise<string[]> {
  return new Promise((resolve) => {
    const messages: string[] = [];
    const timer = setTimeout(() => {
      ws.removeListener("message", handler);
      resolve(messages);
    }, timeoutMs);

    const handler = (data: Buffer) => {
      messages.push(data.toString());
      if (messages.length >= count) {
        clearTimeout(timer);
        ws.removeListener("message", handler);
        resolve(messages);
      }
    };

    ws.on("message", handler);
  });
}

function waitForMessage(
  ws: WebSocket,
  predicate: (msg: unknown) => boolean,
  timeoutMs = 2000,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeListener("message", handler);
      reject(new Error("Timeout waiting for message"));
    }, timeoutMs);

    const handler = (data: Buffer) => {
      try {
        const parsed = JSON.parse(data.toString());
        if (predicate(parsed)) {
          clearTimeout(timer);
          ws.removeListener("message", handler);
          resolve(parsed);
        }
      } catch {
        // Ignore parse errors
      }
    };

    ws.on("message", handler);
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("E2E: Full Session Lifecycle", () => {
  it("complete flow: create session → CLI connects → consumer connects → message exchange", async () => {
    const wsServer = new NodeWebSocketServer({ port: 0 });
    const manager = new SessionManager({
      config: { port: 0 },
      processManager: new NodeProcessManager(),
      storage: new MemoryStorage(),
      server: wsServer,
    });
    await manager.start();

    const port = wsServer.port!;

    // 1. Create session programmatically
    const { sessionId } = manager.launcher.launch({ cwd: process.cwd() });
    expect(sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

    // 2. Simulate CLI connection (normally CLI spawns and connects)
    const cliWs = new WebSocket(`ws://localhost:${port}/ws/cli/${sessionId}`);
    await new Promise((resolve) => cliWs.on("open", resolve));

    // 3. Connect consumer (CLI already connected)
    const consumerWs = new WebSocket(`ws://localhost:${port}/ws/consumer/${sessionId}`);

    // Set up message listener before waiting for open to catch early messages
    const messagesPromise = collectMessages(consumerWs, 3, 1500);

    await new Promise((resolve) => consumerWs.on("open", resolve));

    // Collect initial messages (identity, session_init, and possibly presence_update or cli_connected)
    const initMessages = await messagesPromise;

    // We should get at least identity and session_init
    expect(initMessages.length).toBeGreaterThanOrEqual(2);

    const types = initMessages.map((m) => JSON.parse(m).type);
    expect(types).toContain("identity");
    expect(types).toContain("session_init");

    // 4. Consumer sends user_message
    consumerWs.send(JSON.stringify({ type: "user_message", content: "Hello CLI" }));

    // CLI should receive forwarded message
    const cliMessage = await waitForMessage(
      cliWs,
      (msg: unknown) => (msg as { type: string }).type === "user",
    );
    expect((cliMessage as { type: string }).type).toBe("user");
    expect((cliMessage as { message: { content: string } }).message.content).toBe("Hello CLI");

    // 5. CLI sends assistant response
    cliWs.send(
      JSON.stringify({
        type: "assistant",
        message: {
          id: "msg-1",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-5-20250929",
          content: [{ type: "text", text: "Hello Consumer!" }],
          stop_reason: "end_turn",
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
        parent_tool_use_id: null,
      }),
    );

    // Consumer should receive assistant message
    const consumerMessage = await waitForMessage(
      consumerWs,
      (msg: unknown) => (msg as { type: string }).type === "assistant",
    );
    expect((consumerMessage as { type: string }).type).toBe("assistant");
    expect(
      (consumerMessage as { message: { content: Array<{ text: string }> } }).message.content[0]
        .text,
    ).toBe("Hello Consumer!");

    // 6. Cleanup
    cliWs.close();
    consumerWs.close();
    await manager.launcher.kill(sessionId);
    await manager.stop();
  });

  it("session state persisted to storage and restored after manager restart", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "beamcode-lifecycle-"));
    const storage = new FileStorage(tempDir);

    try {
      // Start first manager instance
      const manager1 = new SessionManager({
        config: { port: 3457 }, // Fixed port for restoration
        processManager: new NodeProcessManager(),
        storage,
      });
      await manager1.start();

      const { sessionId } = manager1.launcher.launch({
        cwd: process.cwd(),
        model: "claude-sonnet-4-5-20250929",
      });
      expect(sessionId).toBeTruthy();

      // Give it time to persist
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Stop first instance
      await manager1.stop();

      // Start second manager instance with same storage
      const manager2 = new SessionManager({
        config: { port: 3457 },
        processManager: new NodeProcessManager(),
        storage,
      });
      await manager2.start();

      // Verify session was restored
      const sessions = manager2.launcher.listSessions();
      const restored = sessions.find((s) => s.sessionId === sessionId);
      expect(restored).toBeDefined();
      expect(restored?.sessionId).toBe(sessionId);

      await manager2.stop();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("multiple consumers receive same messages from CLI", async () => {
    const wsServer = new NodeWebSocketServer({ port: 0 });
    const manager = new SessionManager({
      config: { port: 0 },
      processManager: new NodeProcessManager(),
      storage: new MemoryStorage(),
      server: wsServer,
    });
    await manager.start();

    const port = wsServer.port!;
    const { sessionId } = manager.launcher.launch({ cwd: process.cwd() });

    // Connect 3 consumers
    const consumers = await Promise.all([
      new Promise<WebSocket>((resolve) => {
        const ws = new WebSocket(`ws://localhost:${port}/ws/consumer/${sessionId}`);
        ws.on("open", () => resolve(ws));
      }),
      new Promise<WebSocket>((resolve) => {
        const ws = new WebSocket(`ws://localhost:${port}/ws/consumer/${sessionId}`);
        ws.on("open", () => resolve(ws));
      }),
      new Promise<WebSocket>((resolve) => {
        const ws = new WebSocket(`ws://localhost:${port}/ws/consumer/${sessionId}`);
        ws.on("open", () => resolve(ws));
      }),
    ]);

    // Drain initial messages from all consumers
    await Promise.all(consumers.map((c) => collectMessages(c, 3, 500)));

    // Connect CLI
    const cliWs = new WebSocket(`ws://localhost:${port}/ws/cli/${sessionId}`);
    await new Promise((resolve) => cliWs.on("open", resolve));

    // Wait for all consumers to receive cli_connected
    await Promise.all(
      consumers.map((c) =>
        waitForMessage(c, (msg: unknown) => (msg as { type: string }).type === "cli_connected"),
      ),
    );

    // CLI sends a message
    cliWs.send(
      JSON.stringify({
        type: "assistant",
        message: {
          id: "broadcast-msg",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-5-20250929",
          content: [{ type: "text", text: "Broadcast to all!" }],
          stop_reason: "end_turn",
          usage: {
            input_tokens: 5,
            output_tokens: 3,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
        parent_tool_use_id: null,
      }),
    );

    // All 3 consumers should receive the message
    const messages = await Promise.all(
      consumers.map((c) =>
        waitForMessage(c, (msg: unknown) => (msg as { type: string }).type === "assistant"),
      ),
    );

    expect(messages).toHaveLength(3);
    for (const msg of messages) {
      expect((msg as { type: string }).type).toBe("assistant");
      expect(
        (msg as { message: { content: Array<{ text: string }> } }).message.content[0].text,
      ).toBe("Broadcast to all!");
    }

    // Cleanup
    cliWs.close();
    for (const c of consumers) {
      c.close();
    }
    await manager.stop();
  });

  it("consumer disconnect does not affect other consumers", async () => {
    const wsServer = new NodeWebSocketServer({ port: 0 });
    const manager = new SessionManager({
      config: { port: 0 },
      processManager: new NodeProcessManager(),
      storage: new MemoryStorage(),
      server: wsServer,
    });
    await manager.start();

    const port = wsServer.port!;
    const { sessionId } = manager.launcher.launch({ cwd: process.cwd() });

    // Connect 2 consumers
    const consumer1 = new WebSocket(`ws://localhost:${port}/ws/consumer/${sessionId}`);
    const consumer2 = new WebSocket(`ws://localhost:${port}/ws/consumer/${sessionId}`);

    await Promise.all([
      new Promise((resolve) => consumer1.on("open", resolve)),
      new Promise((resolve) => consumer2.on("open", resolve)),
    ]);

    await Promise.all([collectMessages(consumer1, 2, 500), collectMessages(consumer2, 2, 500)]);

    // Connect CLI
    const cliWs = new WebSocket(`ws://localhost:${port}/ws/cli/${sessionId}`);
    await new Promise((resolve) => cliWs.on("open", resolve));

    // Disconnect consumer1
    consumer1.close();
    await new Promise((resolve) => setTimeout(resolve, 100));

    // CLI sends message
    cliWs.send(
      JSON.stringify({
        type: "assistant",
        message: {
          id: "msg-after-disconnect",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-5-20250929",
          content: [{ type: "text", text: "Still here" }],
          stop_reason: "end_turn",
          usage: {
            input_tokens: 5,
            output_tokens: 2,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
        parent_tool_use_id: null,
      }),
    );

    // Consumer2 should still receive the message
    const msg = await waitForMessage(
      consumer2,
      (m: unknown) => (m as { type: string }).type === "assistant",
    );
    expect((msg as { message: { content: Array<{ text: string }> } }).message.content[0].text).toBe(
      "Still here",
    );

    // Cleanup
    cliWs.close();
    consumer2.close();
    await manager.stop();
  });

  it("session termination broadcasts cli_disconnected to all consumers", async () => {
    const wsServer = new NodeWebSocketServer({ port: 0 });
    const manager = new SessionManager({
      config: { port: 0 },
      processManager: new NodeProcessManager(),
      storage: new MemoryStorage(),
      server: wsServer,
    });
    await manager.start();

    const port = wsServer.port!;
    const { sessionId } = manager.launcher.launch({ cwd: process.cwd() });

    // Connect 2 consumers
    const consumers = await Promise.all([
      new Promise<WebSocket>((resolve) => {
        const ws = new WebSocket(`ws://localhost:${port}/ws/consumer/${sessionId}`);
        ws.on("open", () => resolve(ws));
      }),
      new Promise<WebSocket>((resolve) => {
        const ws = new WebSocket(`ws://localhost:${port}/ws/consumer/${sessionId}`);
        ws.on("open", () => resolve(ws));
      }),
    ]);

    await Promise.all(consumers.map((c) => collectMessages(c, 2, 500)));

    // Connect CLI
    const cliWs = new WebSocket(`ws://localhost:${port}/ws/cli/${sessionId}`);
    await new Promise((resolve) => cliWs.on("open", resolve));

    // Wait for cli_connected
    await Promise.all(
      consumers.map((c) =>
        waitForMessage(c, (msg: unknown) => (msg as { type: string }).type === "cli_connected"),
      ),
    );

    // Disconnect CLI
    cliWs.close();

    // Both consumers should receive cli_disconnected
    const disconnectMessages = await Promise.all(
      consumers.map((c) =>
        waitForMessage(c, (msg: unknown) => (msg as { type: string }).type === "cli_disconnected"),
      ),
    );

    expect(disconnectMessages).toHaveLength(2);
    for (const msg of disconnectMessages) {
      expect((msg as { type: string }).type).toBe("cli_disconnected");
    }

    // Cleanup
    for (const c of consumers) {
      c.close();
    }
    await manager.stop();
  });
});
