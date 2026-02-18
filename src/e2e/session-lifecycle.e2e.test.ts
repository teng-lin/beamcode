import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { FileStorage } from "../adapters/file-storage.js";
import { MemoryStorage } from "../adapters/memory-storage.js";
import { NodeWebSocketServer } from "../adapters/node-ws-server.js";
import { SdkUrlAdapter } from "../adapters/sdk-url/sdk-url-adapter.js";
import { SessionManager } from "../core/session-manager.js";
import {
  closeWebSockets,
  collectMessages,
  connectTestCLI,
  connectTestConsumer,
  createProcessManager,
  getMessageText,
  mockAssistantMessage,
  waitForMessageType,
} from "./helpers/test-utils.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

interface TestEnv {
  manager: SessionManager;
  port: number;
  sessionId: string;
}

/**
 * Sets up a test environment with a SessionManager, WebSocket server, and session.
 *
 * Cleanup: Calling `manager.stop()` will also close the injected `wsServer`,
 * so there's no need to manually clean up the WebSocket server separately.
 */
async function setupTestEnv(): Promise<TestEnv> {
  const wsServer = new NodeWebSocketServer({ port: 0 });
  const adapter = new SdkUrlAdapter();
  const manager = new SessionManager({
    config: { port: 0 },
    processManager: createProcessManager(),
    storage: new MemoryStorage(),
    server: wsServer,
    adapter,
  });
  await manager.start();

  const port = wsServer.port!;
  const { sessionId } = manager.launcher.launch({ cwd: process.cwd() });

  return { manager, port, sessionId };
}

async function connectConsumers(
  port: number,
  sessionId: string,
  count: number,
): Promise<import("ws").WebSocket[]> {
  return Promise.all(Array.from({ length: count }, () => connectTestConsumer(port, sessionId)));
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("E2E: Full Session Lifecycle", () => {
  it("complete flow: create session -> CLI connects -> consumer connects -> message exchange", async () => {
    const { manager, port, sessionId } = await setupTestEnv();

    expect(sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

    // Simulate CLI connection
    const cliWs = await connectTestCLI(port, sessionId);

    // Connect consumer -- set up message listener before awaiting open to catch early messages
    const consumerWs = new WebSocket(`ws://localhost:${port}/ws/consumer/${sessionId}`);
    const messagesPromise = collectMessages(consumerWs, 3, 1500);
    await new Promise((resolve) => consumerWs.on("open", resolve));
    const initMessages = await messagesPromise;

    expect(initMessages.length).toBeGreaterThanOrEqual(2);

    const types = initMessages.map((m) => JSON.parse(m).type);
    expect(types).toContain("identity");
    expect(types).toContain("session_init");

    // Consumer sends user_message, CLI should receive it
    consumerWs.send(JSON.stringify({ type: "user_message", content: "Hello CLI" }));

    const cliMessage = await waitForMessageType(cliWs, "user");
    expect((cliMessage as { type: string }).type).toBe("user");
    expect((cliMessage as { message: { content: string } }).message.content).toBe("Hello CLI");

    // CLI sends assistant response, consumer should receive it
    cliWs.send(JSON.stringify(mockAssistantMessage("Hello Consumer!", "msg-1")));

    const consumerMessage = await waitForMessageType(consumerWs, "assistant");
    expect(getMessageText(consumerMessage)).toBe("Hello Consumer!");

    // Cleanup
    await closeWebSockets(cliWs, consumerWs);
    await manager.launcher.kill(sessionId);
    await manager.stop();
  });

  it("session state persisted to storage and restored after manager restart", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "beamcode-lifecycle-"));
    const storage = new FileStorage(tempDir);

    try {
      const manager1 = new SessionManager({
        config: { port: 3457 },
        processManager: createProcessManager(),
        storage,
      });
      await manager1.start();

      const { sessionId } = manager1.launcher.launch({
        cwd: process.cwd(),
        model: "test-model-id",
      });
      expect(sessionId).toBeTruthy();

      await new Promise((resolve) => setTimeout(resolve, 200));
      await manager1.stop();

      // Restart with same storage
      const manager2 = new SessionManager({
        config: { port: 3457 },
        processManager: createProcessManager(),
        storage,
      });
      await manager2.start();

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
    const { manager, port, sessionId } = await setupTestEnv();

    const consumers = await connectConsumers(port, sessionId, 3);
    await Promise.all(consumers.map((c) => collectMessages(c, 3, 500)));

    const cliWs = await connectTestCLI(port, sessionId);

    // Wait for all consumers to receive cli_connected
    await Promise.all(consumers.map((c) => waitForMessageType(c, "cli_connected")));

    // CLI broadcasts a message
    cliWs.send(JSON.stringify(mockAssistantMessage("Broadcast to all!", "broadcast-msg")));

    const messages = await Promise.all(consumers.map((c) => waitForMessageType(c, "assistant")));

    expect(messages).toHaveLength(3);
    for (const msg of messages) {
      expect((msg as { type: string }).type).toBe("assistant");
      expect(getMessageText(msg)).toBe("Broadcast to all!");
    }

    await closeWebSockets(cliWs, ...consumers);
    await manager.stop();
  });

  it("consumer disconnect does not affect other consumers", async () => {
    const { manager, port, sessionId } = await setupTestEnv();

    const consumer1 = await connectTestConsumer(port, sessionId);
    const consumer2 = await connectTestConsumer(port, sessionId);

    await Promise.all([collectMessages(consumer1, 2, 500), collectMessages(consumer2, 2, 500)]);

    const cliWs = await connectTestCLI(port, sessionId);

    // Disconnect consumer1
    consumer1.close();
    await new Promise((resolve) => setTimeout(resolve, 100));

    // CLI sends message -- consumer2 should still receive it
    cliWs.send(JSON.stringify(mockAssistantMessage("Still here", "msg-after-disconnect")));

    const msg = await waitForMessageType(consumer2, "assistant");
    expect(getMessageText(msg)).toBe("Still here");

    await closeWebSockets(cliWs, consumer2);
    await manager.stop();
  });

  it("session termination broadcasts cli_disconnected to all consumers", async () => {
    const { manager, port, sessionId } = await setupTestEnv();

    const consumers = await connectConsumers(port, sessionId, 2);
    await Promise.all(consumers.map((c) => collectMessages(c, 2, 500)));

    const cliWs = await connectTestCLI(port, sessionId);

    // Wait for cli_connected
    await Promise.all(consumers.map((c) => waitForMessageType(c, "cli_connected")));

    // Disconnect CLI
    cliWs.close();

    // Both consumers should receive cli_disconnected
    const disconnectMessages = await Promise.all(
      consumers.map((c) => waitForMessageType(c, "cli_disconnected")),
    );

    expect(disconnectMessages).toHaveLength(2);
    for (const msg of disconnectMessages) {
      expect((msg as { type: string }).type).toBe("cli_disconnected");
    }

    await closeWebSockets(...consumers);
    await manager.stop();
  });
});
