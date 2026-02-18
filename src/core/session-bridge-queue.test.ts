import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:crypto", () => ({ randomUUID: () => "test-uuid" }));

import {
  createBridgeWithAdapter,
  type MockBackendAdapter,
  type MockBackendSession,
  makeResultUnifiedMsg,
  makeStatusChangeMsg,
  makeStreamEventUnifiedMsg,
  setupInitializedSession,
  tick,
} from "../testing/adapter-test-helpers.js";
import {
  authContext,
  createTestSocket as createMockSocket,
} from "../testing/cli-message-factories.js";
import type { SessionBridge } from "./session-bridge.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Set up a session via the adapter path with a consumer connected. */
async function setupSession(bridge: SessionBridge, adapter: MockBackendAdapter) {
  const backendSession = await setupInitializedSession(bridge, adapter, "sess-1");

  const consumerSocket = createMockSocket();
  bridge.handleConsumerOpen(consumerSocket, authContext("sess-1"));
  consumerSocket.sentMessages.length = 0;

  return { backendSession, consumerSocket };
}

/** Simulate a status change coming from the backend. */
async function simulateStatusChange(backendSession: MockBackendSession, status: string | null) {
  backendSession.pushMessage(makeStatusChangeMsg({ status }));
  await tick();
}

/** Simulate the backend starting a response (stream_event message_start). */
async function simulateMessageStart(backendSession: MockBackendSession) {
  backendSession.pushMessage(
    makeStreamEventUnifiedMsg({
      event: { type: "message_start" },
      parent_tool_use_id: null,
    }),
  );
  await tick();
}

/** Simulate the backend completing a turn (result message). */
async function simulateResult(backendSession: MockBackendSession) {
  backendSession.pushMessage(makeResultUnifiedMsg());
  await tick();
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
function _findMessages(socket: ReturnType<typeof createMockSocket>, type: string) {
  return parseSent(socket).filter((m: { type: string }) => m.type === type);
}

/**
 * Check if a user_message UnifiedMessage with the given content was sent to the backend.
 * In the adapter path, sendUserMessage calls backendSession.send() with a UnifiedMessage
 * of type "user_message" containing a text content block.
 */
function backendReceivedUserMessage(backendSession: MockBackendSession, content: string): boolean {
  return backendSession.sentMessages.some(
    (m) =>
      m.type === "user_message" && m.content.some((b) => b.type === "text" && b.text === content),
  );
}

/**
 * Find a user_message UnifiedMessage sent to the backend.
 */
function findBackendUserMessage(backendSession: MockBackendSession) {
  return backendSession.sentMessages.find((m) => m.type === "user_message");
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("SessionBridge — message queue handlers", () => {
  let bridge: SessionBridge;
  let adapter: MockBackendAdapter;

  beforeEach(() => {
    const created = createBridgeWithAdapter();
    bridge = created.bridge;
    adapter = created.adapter;
  });

  // ── queue_message ──────────────────────────────────────────────────────

  describe("queue_message", () => {
    it("stores in queuedMessage and broadcasts message_queued when session is running", async () => {
      const { consumerSocket, backendSession } = await setupSession(bridge, adapter);

      // Set status to running
      await simulateStatusChange(backendSession, "running");
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

    it("sends immediately as user_message when session is idle", async () => {
      const { backendSession, consumerSocket } = await setupSession(bridge, adapter);

      // Status is null (default/idle) — message should be sent immediately
      bridge.handleConsumerMessage(
        consumerSocket,
        "sess-1",
        JSON.stringify({ type: "queue_message", content: "immediate text" }),
      );

      // Should have been forwarded to backend as a user message
      expect(backendReceivedUserMessage(backendSession, "immediate text")).toBe(true);

      // Should NOT have broadcast message_queued
      const queued = findMessage(consumerSocket, "message_queued");
      expect(queued).toBeUndefined();
    });

    it("sends immediately when session status is explicitly idle", async () => {
      const { backendSession, consumerSocket } = await setupSession(bridge, adapter);

      // Explicitly set idle
      await simulateStatusChange(backendSession, "idle");
      backendSession.sentMessages.length = 0;
      consumerSocket.sentMessages.length = 0;

      bridge.handleConsumerMessage(
        consumerSocket,
        "sess-1",
        JSON.stringify({ type: "queue_message", content: "idle text" }),
      );

      expect(backendReceivedUserMessage(backendSession, "idle text")).toBe(true);
    });

    it("rejects with error when a message is already queued", async () => {
      const { consumerSocket, backendSession } = await setupSession(bridge, adapter);

      // Set status to running
      await simulateStatusChange(backendSession, "running");
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

    it("includes images in the queued message and broadcast", async () => {
      const { consumerSocket, backendSession } = await setupSession(bridge, adapter);

      await simulateStatusChange(backendSession, "running");
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
    it("updates the queued message and broadcasts when called by the author", async () => {
      const { consumerSocket, backendSession } = await setupSession(bridge, adapter);

      await simulateStatusChange(backendSession, "running");
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

    it("rejects update from a different user", async () => {
      const { consumerSocket, backendSession } = await setupSession(bridge, adapter);

      await simulateStatusChange(backendSession, "running");
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

    it("is a no-op when no message is queued", async () => {
      const { consumerSocket } = await setupSession(bridge, adapter);

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
    it("cancels the queued message and broadcasts when called by the author", async () => {
      const { consumerSocket, backendSession } = await setupSession(bridge, adapter);

      await simulateStatusChange(backendSession, "running");
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

    it("rejects cancel from a different user", async () => {
      const { consumerSocket, backendSession } = await setupSession(bridge, adapter);

      await simulateStatusChange(backendSession, "running");
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

    it("is a no-op when no message is queued", async () => {
      const { consumerSocket } = await setupSession(bridge, adapter);

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
    it("auto-sends the queued message when status transitions to idle", async () => {
      const { backendSession, consumerSocket } = await setupSession(bridge, adapter);

      // Set status to running
      await simulateStatusChange(backendSession, "running");
      consumerSocket.sentMessages.length = 0;
      backendSession.sentMessages.length = 0;

      // Queue a message
      bridge.handleConsumerMessage(
        consumerSocket,
        "sess-1",
        JSON.stringify({ type: "queue_message", content: "auto-send me" }),
      );
      backendSession.sentMessages.length = 0;
      consumerSocket.sentMessages.length = 0;

      // Transition to idle — should auto-send
      await simulateStatusChange(backendSession, "idle");

      // The queued message should have been sent to backend
      expect(backendReceivedUserMessage(backendSession, "auto-send me")).toBe(true);

      // Should have broadcast queued_message_sent (not cancelled)
      const sent = findMessage(consumerSocket, "queued_message_sent");
      expect(sent).toBeDefined();
    });

    it("does not auto-send when status transitions to running", async () => {
      const { backendSession, consumerSocket } = await setupSession(bridge, adapter);

      // Set status to running
      await simulateStatusChange(backendSession, "running");
      consumerSocket.sentMessages.length = 0;

      // Queue a message
      bridge.handleConsumerMessage(
        consumerSocket,
        "sess-1",
        JSON.stringify({ type: "queue_message", content: "stay queued" }),
      );
      backendSession.sentMessages.length = 0;

      // Transition to compacting — should NOT auto-send
      await simulateStatusChange(backendSession, "compacting");

      expect(backendReceivedUserMessage(backendSession, "stay queued")).toBe(false);
    });

    it("does nothing when status is idle but no message is queued", async () => {
      const { backendSession, consumerSocket } = await setupSession(bridge, adapter);

      await simulateStatusChange(backendSession, "running");
      backendSession.sentMessages.length = 0;
      consumerSocket.sentMessages.length = 0;

      // Transition to idle with no queued message
      await simulateStatusChange(backendSession, "idle");

      // Should NOT have sent any user message to backend (only status_change)
      expect(findBackendUserMessage(backendSession)).toBeUndefined();
    });

    it("auto-sends with images when queued message has images", async () => {
      const { backendSession, consumerSocket } = await setupSession(bridge, adapter);

      await simulateStatusChange(backendSession, "running");
      consumerSocket.sentMessages.length = 0;
      backendSession.sentMessages.length = 0;

      const images = [{ media_type: "image/png", data: "base64img" }];
      bridge.handleConsumerMessage(
        consumerSocket,
        "sess-1",
        JSON.stringify({ type: "queue_message", content: "with img", images }),
      );
      backendSession.sentMessages.length = 0;

      // Transition to idle
      await simulateStatusChange(backendSession, "idle");

      // The user message should include images (content block array format)
      const userMsg = findBackendUserMessage(backendSession);
      expect(userMsg).toBeDefined();
      // With images, content is an array of content blocks
      expect(Array.isArray(userMsg!.content)).toBe(true);
      expect(userMsg!.content.some((b) => b.type === "image")).toBe(true);
    });
  });

  // ── Realistic CLI flow (stream_event + result) ──────────────────────────

  describe("queue with realistic CLI flow (message_start / result)", () => {
    it("queues message when CLI is streaming (message_start sets running)", async () => {
      const { consumerSocket, backendSession } = await setupSession(bridge, adapter);

      // Simulate the backend starting a response — this is what the real CLI does
      // instead of sending status_change "running"
      await simulateMessageStart(backendSession);
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

    it("auto-sends queued message when CLI sends result", async () => {
      const { backendSession, consumerSocket } = await setupSession(bridge, adapter);

      // CLI starts streaming
      await simulateMessageStart(backendSession);
      consumerSocket.sentMessages.length = 0;

      // Queue a message while running
      bridge.handleConsumerMessage(
        consumerSocket,
        "sess-1",
        JSON.stringify({ type: "queue_message", content: "send on idle" }),
      );
      backendSession.sentMessages.length = 0;
      consumerSocket.sentMessages.length = 0;

      // CLI finishes — result triggers auto-send
      await simulateResult(backendSession);

      // Should have broadcast queued_message_sent
      const sent = findMessage(consumerSocket, "queued_message_sent");
      expect(sent).toBeDefined();

      // Should have forwarded to backend as user message
      expect(backendReceivedUserMessage(backendSession, "send on idle")).toBe(true);
    });

    it("sends immediately when CLI is idle (no message_start)", async () => {
      const { backendSession, consumerSocket } = await setupSession(bridge, adapter);

      // No message_start — session is idle (lastStatus is null after init)
      bridge.handleConsumerMessage(
        consumerSocket,
        "sess-1",
        JSON.stringify({ type: "queue_message", content: "idle text" }),
      );

      // Should have sent to backend immediately
      expect(backendReceivedUserMessage(backendSession, "idle text")).toBe(true);

      // Should NOT have broadcast message_queued
      expect(findMessage(consumerSocket, "message_queued")).toBeUndefined();
    });

    it("does not set running from subagent message_start", async () => {
      const { backendSession, consumerSocket } = await setupSession(bridge, adapter);

      // Simulate a subagent message_start (has parent_tool_use_id)
      backendSession.pushMessage(
        makeStreamEventUnifiedMsg({
          event: { type: "message_start" },
          parent_tool_use_id: "tool-123",
        }),
      );
      await tick();

      // Status should still be null/idle — queue_message should send immediately
      bridge.handleConsumerMessage(
        consumerSocket,
        "sess-1",
        JSON.stringify({ type: "queue_message", content: "should be immediate" }),
      );

      expect(backendReceivedUserMessage(backendSession, "should be immediate")).toBe(true);
      expect(findMessage(consumerSocket, "message_queued")).toBeUndefined();
    });

    it("queues message sent right after user_message (optimistic running)", async () => {
      const { backendSession, consumerSocket } = await setupSession(bridge, adapter);

      // Send a user_message — this should optimistically set lastStatus to "running"
      bridge.handleConsumerMessage(
        consumerSocket,
        "sess-1",
        JSON.stringify({ type: "user_message", content: "first message" }),
      );
      backendSession.sentMessages.length = 0;
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
