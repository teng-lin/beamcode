import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:crypto", () => ({ randomUUID: () => "test-uuid" }));

import { MemoryStorage } from "../adapters/memory-storage.js";
import type { ConsumerIdentity } from "../interfaces/auth.js";
import {
  authContext,
  createTestSocket as createMockSocket,
  makeInitMsg,
  makeResultMsg,
  makeStatusMsg,
  makeStreamEventMsg,
  noopLogger,
} from "../testing/cli-message-factories.js";
import { SessionBridge } from "./session-bridge.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function createBridge() {
  const storage = new MemoryStorage();
  return {
    bridge: new SessionBridge({
      storage,
      config: { port: 3456 },
      logger: noopLogger,
    }),
    storage,
  };
}

/** Set up a session with CLI connected, a consumer connected, and return useful handles. */
function setupSession(bridge: SessionBridge) {
  bridge.getOrCreateSession("sess-1");
  const cliSocket = createMockSocket();
  bridge.handleCLIOpen(cliSocket, "sess-1");
  // Send init so the session is fully bootstrapped
  bridge.handleCLIMessage("sess-1", makeInitMsg());
  cliSocket.sentMessages.length = 0;

  const consumerSocket = createMockSocket();
  bridge.handleConsumerOpen(consumerSocket, authContext("sess-1"));
  consumerSocket.sentMessages.length = 0;

  return { cliSocket, consumerSocket };
}

/** Simulate a status change coming from the CLI (via handleCLIMessage). */
function simulateStatusChange(bridge: SessionBridge, sessionId: string, status: string | null) {
  bridge.handleCLIMessage(sessionId, makeStatusMsg({ status }));
}

/** Simulate the CLI starting a response (stream_event message_start). */
function simulateMessageStart(bridge: SessionBridge, sessionId: string) {
  bridge.handleCLIMessage(
    sessionId,
    makeStreamEventMsg({ event: { type: "message_start" }, parent_tool_use_id: null }),
  );
}

/** Simulate the CLI completing a turn (result message). */
function simulateResult(bridge: SessionBridge, sessionId: string) {
  bridge.handleCLIMessage(sessionId, makeResultMsg());
}

/** Parse all JSON messages sent to a socket and return them. */
function parseSent(socket: ReturnType<typeof createMockSocket>) {
  return socket.sentMessages.map((m) => JSON.parse(m));
}

/** Find a message of a given type in a socket's sent messages. */
function findMessage(socket: ReturnType<typeof createMockSocket>, type: string) {
  return parseSent(socket).find((m: { type: string }) => m.type === type);
}

/** Find all messages of a given type in a socket's sent messages. */
function findMessages(socket: ReturnType<typeof createMockSocket>, type: string) {
  return parseSent(socket).filter((m: { type: string }) => m.type === type);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("SessionBridge — message queue handlers", () => {
  let bridge: SessionBridge;

  beforeEach(() => {
    const created = createBridge();
    bridge = created.bridge;
  });

  // ── queue_message ──────────────────────────────────────────────────────

  describe("queue_message", () => {
    it("stores in queuedMessage and broadcasts message_queued when session is running", () => {
      const { consumerSocket } = setupSession(bridge);

      // Set status to running
      simulateStatusChange(bridge, "sess-1", "running");
      consumerSocket.sentMessages.length = 0;

      // Queue a message
      bridge.handleConsumerMessage(
        consumerSocket,
        "sess-1",
        JSON.stringify({ type: "queue_message", content: "queued text" }),
      );

      const queued = findMessage(consumerSocket, "message_queued");
      expect(queued).toBeDefined();
      expect(queued.content).toBe("queued text");
      expect(queued.consumer_id).toBeDefined();
      expect(queued.display_name).toBeDefined();
      expect(queued.queued_at).toBeTypeOf("number");
    });

    it("sends immediately as user_message when session is idle", () => {
      const { cliSocket, consumerSocket } = setupSession(bridge);

      // Status is null (default/idle) — message should be sent immediately
      bridge.handleConsumerMessage(
        consumerSocket,
        "sess-1",
        JSON.stringify({ type: "queue_message", content: "immediate text" }),
      );

      // Should have been forwarded to CLI as a user message
      const sentToCli = cliSocket.sentMessages.map((m) => JSON.parse(m.trim()));
      expect(
        sentToCli.some((m: any) => m.type === "user" && m.message.content === "immediate text"),
      ).toBe(true);

      // Should NOT have broadcast message_queued
      const queued = findMessage(consumerSocket, "message_queued");
      expect(queued).toBeUndefined();
    });

    it("sends immediately when session status is explicitly idle", () => {
      const { cliSocket, consumerSocket } = setupSession(bridge);

      // Explicitly set idle
      simulateStatusChange(bridge, "sess-1", "idle");
      cliSocket.sentMessages.length = 0;
      consumerSocket.sentMessages.length = 0;

      bridge.handleConsumerMessage(
        consumerSocket,
        "sess-1",
        JSON.stringify({ type: "queue_message", content: "idle text" }),
      );

      const sentToCli = cliSocket.sentMessages.map((m) => JSON.parse(m.trim()));
      expect(
        sentToCli.some((m: any) => m.type === "user" && m.message.content === "idle text"),
      ).toBe(true);
    });

    it("rejects with error when a message is already queued", () => {
      const { consumerSocket } = setupSession(bridge);

      // Set status to running
      simulateStatusChange(bridge, "sess-1", "running");
      consumerSocket.sentMessages.length = 0;

      // Queue first message
      bridge.handleConsumerMessage(
        consumerSocket,
        "sess-1",
        JSON.stringify({ type: "queue_message", content: "first" }),
      );

      // Try to queue a second message
      bridge.handleConsumerMessage(
        consumerSocket,
        "sess-1",
        JSON.stringify({ type: "queue_message", content: "second" }),
      );

      const errorMsg = findMessage(consumerSocket, "error");
      expect(errorMsg).toBeDefined();
      expect(errorMsg.message).toContain("already queued");
    });

    it("includes images in the queued message and broadcast", () => {
      const { consumerSocket } = setupSession(bridge);

      simulateStatusChange(bridge, "sess-1", "running");
      consumerSocket.sentMessages.length = 0;

      const images = [{ media_type: "image/png", data: "base64data" }];
      bridge.handleConsumerMessage(
        consumerSocket,
        "sess-1",
        JSON.stringify({ type: "queue_message", content: "with image", images }),
      );

      const queued = findMessage(consumerSocket, "message_queued");
      expect(queued).toBeDefined();
      expect(queued.images).toEqual(images);
    });
  });

  // ── update_queued_message ──────────────────────────────────────────────

  describe("update_queued_message", () => {
    it("updates the queued message and broadcasts when called by the author", () => {
      const { consumerSocket } = setupSession(bridge);

      simulateStatusChange(bridge, "sess-1", "running");
      consumerSocket.sentMessages.length = 0;

      // Queue a message
      bridge.handleConsumerMessage(
        consumerSocket,
        "sess-1",
        JSON.stringify({ type: "queue_message", content: "original" }),
      );

      // Update it
      bridge.handleConsumerMessage(
        consumerSocket,
        "sess-1",
        JSON.stringify({ type: "update_queued_message", content: "updated" }),
      );

      const updated = findMessage(consumerSocket, "queued_message_updated");
      expect(updated).toBeDefined();
      expect(updated.content).toBe("updated");
    });

    it("rejects update from a different user", () => {
      const { consumerSocket } = setupSession(bridge);

      simulateStatusChange(bridge, "sess-1", "running");
      consumerSocket.sentMessages.length = 0;

      // Queue a message from the first consumer
      bridge.handleConsumerMessage(
        consumerSocket,
        "sess-1",
        JSON.stringify({ type: "queue_message", content: "original" }),
      );

      // Create a second consumer
      const consumer2 = createMockSocket();
      bridge.handleConsumerOpen(consumer2, authContext("sess-1"));
      consumer2.sentMessages.length = 0;

      // Try to update from the second consumer
      bridge.handleConsumerMessage(
        consumer2,
        "sess-1",
        JSON.stringify({ type: "update_queued_message", content: "hacked" }),
      );

      const errorMsg = findMessage(consumer2, "error");
      expect(errorMsg).toBeDefined();
      expect(errorMsg.message).toContain("Only the message author");
    });

    it("is a no-op when no message is queued", () => {
      const { consumerSocket } = setupSession(bridge);

      bridge.handleConsumerMessage(
        consumerSocket,
        "sess-1",
        JSON.stringify({ type: "update_queued_message", content: "nothing" }),
      );

      // Should not have broadcast anything
      const updated = findMessage(consumerSocket, "queued_message_updated");
      expect(updated).toBeUndefined();
    });
  });

  // ── cancel_queued_message ──────────────────────────────────────────────

  describe("cancel_queued_message", () => {
    it("cancels the queued message and broadcasts when called by the author", () => {
      const { consumerSocket } = setupSession(bridge);

      simulateStatusChange(bridge, "sess-1", "running");
      consumerSocket.sentMessages.length = 0;

      // Queue a message
      bridge.handleConsumerMessage(
        consumerSocket,
        "sess-1",
        JSON.stringify({ type: "queue_message", content: "to cancel" }),
      );

      // Cancel it
      bridge.handleConsumerMessage(
        consumerSocket,
        "sess-1",
        JSON.stringify({ type: "cancel_queued_message" }),
      );

      const cancelled = findMessage(consumerSocket, "queued_message_cancelled");
      expect(cancelled).toBeDefined();
    });

    it("rejects cancel from a different user", () => {
      const { consumerSocket } = setupSession(bridge);

      simulateStatusChange(bridge, "sess-1", "running");
      consumerSocket.sentMessages.length = 0;

      // Queue a message from the first consumer
      bridge.handleConsumerMessage(
        consumerSocket,
        "sess-1",
        JSON.stringify({ type: "queue_message", content: "mine" }),
      );

      // Create a second consumer
      const consumer2 = createMockSocket();
      bridge.handleConsumerOpen(consumer2, authContext("sess-1"));
      consumer2.sentMessages.length = 0;

      // Try to cancel from the second consumer
      bridge.handleConsumerMessage(
        consumer2,
        "sess-1",
        JSON.stringify({ type: "cancel_queued_message" }),
      );

      const errorMsg = findMessage(consumer2, "error");
      expect(errorMsg).toBeDefined();
      expect(errorMsg.message).toContain("Only the message author");
    });

    it("is a no-op when no message is queued", () => {
      const { consumerSocket } = setupSession(bridge);

      bridge.handleConsumerMessage(
        consumerSocket,
        "sess-1",
        JSON.stringify({ type: "cancel_queued_message" }),
      );

      // Should not have broadcast queued_message_cancelled
      const cancelled = findMessage(consumerSocket, "queued_message_cancelled");
      expect(cancelled).toBeUndefined();
    });
  });

  // ── Auto-send on status_change to idle ─────────────────────────────────

  describe("auto-send on status_change to idle", () => {
    it("auto-sends the queued message when status transitions to idle", () => {
      const { cliSocket, consumerSocket } = setupSession(bridge);

      // Set status to running
      simulateStatusChange(bridge, "sess-1", "running");
      consumerSocket.sentMessages.length = 0;
      cliSocket.sentMessages.length = 0;

      // Queue a message
      bridge.handleConsumerMessage(
        consumerSocket,
        "sess-1",
        JSON.stringify({ type: "queue_message", content: "auto-send me" }),
      );
      cliSocket.sentMessages.length = 0;
      consumerSocket.sentMessages.length = 0;

      // Transition to idle — should auto-send
      simulateStatusChange(bridge, "sess-1", "idle");

      // The queued message should have been sent to CLI
      const sentToCli = cliSocket.sentMessages.map((m) => JSON.parse(m.trim()));
      expect(
        sentToCli.some((m: any) => m.type === "user" && m.message.content === "auto-send me"),
      ).toBe(true);

      // Should have broadcast queued_message_sent (not cancelled)
      const sent = findMessage(consumerSocket, "queued_message_sent");
      expect(sent).toBeDefined();
    });

    it("does not auto-send when status transitions to running", () => {
      const { cliSocket, consumerSocket } = setupSession(bridge);

      // Set status to running
      simulateStatusChange(bridge, "sess-1", "running");
      consumerSocket.sentMessages.length = 0;

      // Queue a message
      bridge.handleConsumerMessage(
        consumerSocket,
        "sess-1",
        JSON.stringify({ type: "queue_message", content: "stay queued" }),
      );
      cliSocket.sentMessages.length = 0;

      // Transition to compacting — should NOT auto-send
      simulateStatusChange(bridge, "sess-1", "compacting");

      const sentToCli = cliSocket.sentMessages.map((m) => JSON.parse(m.trim()));
      expect(
        sentToCli.some((m: any) => m.type === "user" && m.message.content === "stay queued"),
      ).toBe(false);
    });

    it("does nothing when status is idle but no message is queued", () => {
      const { cliSocket, consumerSocket } = setupSession(bridge);

      simulateStatusChange(bridge, "sess-1", "running");
      cliSocket.sentMessages.length = 0;
      consumerSocket.sentMessages.length = 0;

      // Transition to idle with no queued message
      simulateStatusChange(bridge, "sess-1", "idle");

      // Should NOT have sent any user message to CLI (only status_change)
      const sentToCli = cliSocket.sentMessages.map((m) => JSON.parse(m.trim()));
      expect(sentToCli.some((m: any) => m.type === "user")).toBe(false);
    });

    it("auto-sends with images when queued message has images", () => {
      const { cliSocket, consumerSocket } = setupSession(bridge);

      simulateStatusChange(bridge, "sess-1", "running");
      consumerSocket.sentMessages.length = 0;
      cliSocket.sentMessages.length = 0;

      const images = [{ media_type: "image/png", data: "base64img" }];
      bridge.handleConsumerMessage(
        consumerSocket,
        "sess-1",
        JSON.stringify({ type: "queue_message", content: "with img", images }),
      );
      cliSocket.sentMessages.length = 0;

      // Transition to idle
      simulateStatusChange(bridge, "sess-1", "idle");

      // The user message should include images (content block array format)
      const sentToCli = cliSocket.sentMessages.map((m) => JSON.parse(m.trim()));
      const userMsg = sentToCli.find((m: any) => m.type === "user");
      expect(userMsg).toBeDefined();
      // With images, content is an array of content blocks
      expect(Array.isArray(userMsg.message.content)).toBe(true);
      expect(userMsg.message.content.some((b: any) => b.type === "image")).toBe(true);
    });
  });

  // ── Realistic CLI flow (stream_event + result) ──────────────────────────

  describe("queue with realistic CLI flow (message_start / result)", () => {
    it("queues message when CLI is streaming (message_start sets running)", () => {
      const { consumerSocket } = setupSession(bridge);

      // Simulate the CLI starting a response — this is what the real CLI does
      // instead of sending status_change "running"
      simulateMessageStart(bridge, "sess-1");
      consumerSocket.sentMessages.length = 0;

      // Queue a message while running
      bridge.handleConsumerMessage(
        consumerSocket,
        "sess-1",
        JSON.stringify({ type: "queue_message", content: "queued via stream" }),
      );

      const queued = findMessage(consumerSocket, "message_queued");
      expect(queued).toBeDefined();
      expect(queued.content).toBe("queued via stream");
    });

    it("auto-sends queued message when CLI sends result", () => {
      const { cliSocket, consumerSocket } = setupSession(bridge);

      // CLI starts streaming
      simulateMessageStart(bridge, "sess-1");
      consumerSocket.sentMessages.length = 0;

      // Queue a message while running
      bridge.handleConsumerMessage(
        consumerSocket,
        "sess-1",
        JSON.stringify({ type: "queue_message", content: "send on idle" }),
      );
      cliSocket.sentMessages.length = 0;
      consumerSocket.sentMessages.length = 0;

      // CLI finishes — result triggers auto-send
      simulateResult(bridge, "sess-1");

      // Should have broadcast queued_message_sent
      const sent = findMessage(consumerSocket, "queued_message_sent");
      expect(sent).toBeDefined();

      // Should have forwarded to CLI as user message
      const sentToCli = cliSocket.sentMessages.map((m) => JSON.parse(m.trim()));
      expect(
        sentToCli.some((m: any) => m.type === "user" && m.message.content === "send on idle"),
      ).toBe(true);
    });

    it("sends immediately when CLI is idle (no message_start)", () => {
      const { cliSocket, consumerSocket } = setupSession(bridge);

      // No message_start — session is idle (lastStatus is null after init)
      bridge.handleConsumerMessage(
        consumerSocket,
        "sess-1",
        JSON.stringify({ type: "queue_message", content: "idle text" }),
      );

      // Should have sent to CLI immediately
      const sentToCli = cliSocket.sentMessages.map((m) => JSON.parse(m.trim()));
      expect(
        sentToCli.some((m: any) => m.type === "user" && m.message.content === "idle text"),
      ).toBe(true);

      // Should NOT have broadcast message_queued
      expect(findMessage(consumerSocket, "message_queued")).toBeUndefined();
    });

    it("does not set running from subagent message_start", () => {
      const { cliSocket, consumerSocket } = setupSession(bridge);

      // Simulate a subagent message_start (has parent_tool_use_id)
      bridge.handleCLIMessage(
        "sess-1",
        makeStreamEventMsg({
          event: { type: "message_start" },
          parent_tool_use_id: "tool-123",
        }),
      );

      // Status should still be null/idle — queue_message should send immediately
      bridge.handleConsumerMessage(
        consumerSocket,
        "sess-1",
        JSON.stringify({ type: "queue_message", content: "should be immediate" }),
      );

      const sentToCli = cliSocket.sentMessages.map((m) => JSON.parse(m.trim()));
      expect(
        sentToCli.some(
          (m: any) => m.type === "user" && m.message.content === "should be immediate",
        ),
      ).toBe(true);
      expect(findMessage(consumerSocket, "message_queued")).toBeUndefined();
    });

    it("queues message sent right after user_message (optimistic running)", () => {
      const { cliSocket, consumerSocket } = setupSession(bridge);

      // Send a user_message — this should optimistically set lastStatus to "running"
      bridge.handleConsumerMessage(
        consumerSocket,
        "sess-1",
        JSON.stringify({ type: "user_message", content: "first message" }),
      );
      cliSocket.sentMessages.length = 0;
      consumerSocket.sentMessages.length = 0;

      // Immediately queue another message — should be queued because
      // handleUserMessage set lastStatus = "running"
      bridge.handleConsumerMessage(
        consumerSocket,
        "sess-1",
        JSON.stringify({ type: "queue_message", content: "follow-up" }),
      );

      const queued = findMessage(consumerSocket, "message_queued");
      expect(queued).toBeDefined();
      expect(queued.content).toBe("follow-up");
    });
  });
});
