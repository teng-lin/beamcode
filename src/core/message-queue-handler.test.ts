import { describe, expect, it, vi } from "vitest";
import {
  createMockSession,
  createTestSocket,
  findMessage,
  noopLogger,
} from "../testing/cli-message-factories.js";
import { ConsumerBroadcaster } from "./consumer-broadcaster.js";
import { MessageQueueHandler } from "./message-queue-handler.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function setup() {
  const broadcaster = new ConsumerBroadcaster(noopLogger);
  const sendUserMessage = vi.fn();
  const handler = new MessageQueueHandler(broadcaster, sendUserMessage);

  const ws = createTestSocket();
  const session = createMockSession({ lastStatus: null });

  session.consumerSockets.set(ws, {
    userId: "user-1",
    displayName: "Alice",
    role: "participant",
    sessionId: "sess-1",
  });

  return { handler, broadcaster, sendUserMessage, session, ws };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("MessageQueueHandler", () => {
  describe("handleQueueMessage", () => {
    it("sends immediately when session status is null (unknown/idle)", () => {
      const { handler, sendUserMessage, session, ws } = setup();

      handler.handleQueueMessage(session, { type: "queue_message", content: "hello" }, ws);

      expect(sendUserMessage).toHaveBeenCalledWith("sess-1", "hello", { images: undefined });
    });

    it("sends immediately when session status is idle", () => {
      const { handler, sendUserMessage, session, ws } = setup();
      session.lastStatus = "idle";

      handler.handleQueueMessage(session, { type: "queue_message", content: "hello" }, ws);

      expect(sendUserMessage).toHaveBeenCalledWith("sess-1", "hello", { images: undefined });
    });

    it("sets lastStatus to running after immediate send", () => {
      const { handler, session, ws } = setup();

      handler.handleQueueMessage(session, { type: "queue_message", content: "hello" }, ws);

      expect(session.lastStatus).toBe("running");
    });

    it("queues message and broadcasts message_queued when session is running", () => {
      const { handler, sendUserMessage, session, ws } = setup();
      session.lastStatus = "running";

      handler.handleQueueMessage(session, { type: "queue_message", content: "queued text" }, ws);

      expect(sendUserMessage).not.toHaveBeenCalled();
      expect(session.queuedMessage).not.toBeNull();
      expect(session.queuedMessage!.content).toBe("queued text");
      expect(session.queuedMessage!.consumerId).toBe("user-1");
      expect(session.queuedMessage!.displayName).toBe("Alice");

      const queued = findMessage(ws, "message_queued");
      expect(queued).toBeDefined();
      expect(queued.content).toBe("queued text");
      expect(queued.consumer_id).toBe("user-1");
      expect(queued.display_name).toBe("Alice");
      expect(queued.queued_at).toBeTypeOf("number");
    });

    it("queues message when session is compacting", () => {
      const { handler, sendUserMessage, session, ws } = setup();
      session.lastStatus = "compacting";

      handler.handleQueueMessage(
        session,
        { type: "queue_message", content: "wait for compact" },
        ws,
      );

      expect(sendUserMessage).not.toHaveBeenCalled();
      expect(session.queuedMessage).not.toBeNull();
    });

    it("rejects with error when a message is already queued", () => {
      const { handler, session, ws } = setup();
      session.lastStatus = "running";

      // Queue first message
      handler.handleQueueMessage(session, { type: "queue_message", content: "first" }, ws);
      ws.sentMessages.length = 0;

      // Try to queue a second
      handler.handleQueueMessage(session, { type: "queue_message", content: "second" }, ws);

      const error = findMessage(ws, "error");
      expect(error).toBeDefined();
      expect(error.message).toContain("already queued");

      // Original message should be unchanged
      expect(session.queuedMessage!.content).toBe("first");
    });

    it("is a silent no-op when ws has no identity", () => {
      const { handler, sendUserMessage, session } = setup();
      session.lastStatus = "running";

      const unknownWs = createTestSocket();
      // unknownWs is NOT in session.consumerSockets

      handler.handleQueueMessage(session, { type: "queue_message", content: "ghost" }, unknownWs);

      expect(sendUserMessage).not.toHaveBeenCalled();
      expect(session.queuedMessage).toBeNull();
      expect(unknownWs.sentMessages).toHaveLength(0);
    });

    it("includes images in the queued message and broadcast", () => {
      const { handler, session, ws } = setup();
      session.lastStatus = "running";

      const images = [{ media_type: "image/png", data: "base64data" }];
      handler.handleQueueMessage(
        session,
        { type: "queue_message", content: "with image", images },
        ws,
      );

      expect(session.queuedMessage!.images).toEqual(images);
      const queued = findMessage(ws, "message_queued");
      expect(queued.images).toEqual(images);
    });

    it("passes images through on immediate send", () => {
      const { handler, sendUserMessage, session, ws } = setup();
      const images = [{ media_type: "image/png", data: "base64data" }];

      handler.handleQueueMessage(
        session,
        { type: "queue_message", content: "immediate", images },
        ws,
      );

      expect(sendUserMessage).toHaveBeenCalledWith("sess-1", "immediate", { images });
    });
  });

  describe("handleUpdateQueuedMessage", () => {
    it("updates content and broadcasts queued_message_updated", () => {
      const { handler, session, ws } = setup();
      session.lastStatus = "running";

      handler.handleQueueMessage(session, { type: "queue_message", content: "original" }, ws);
      ws.sentMessages.length = 0;

      handler.handleUpdateQueuedMessage(
        session,
        { type: "update_queued_message", content: "updated" },
        ws,
      );

      expect(session.queuedMessage!.content).toBe("updated");
      const updated = findMessage(ws, "queued_message_updated");
      expect(updated).toBeDefined();
      expect(updated.content).toBe("updated");
    });

    it("updates images when provided", () => {
      const { handler, session, ws } = setup();
      session.lastStatus = "running";

      handler.handleQueueMessage(session, { type: "queue_message", content: "text" }, ws);
      ws.sentMessages.length = 0;

      const newImages = [{ media_type: "image/jpeg", data: "newdata" }];
      handler.handleUpdateQueuedMessage(
        session,
        { type: "update_queued_message", content: "text", images: newImages },
        ws,
      );

      expect(session.queuedMessage!.images).toEqual(newImages);
    });

    it("rejects update from a different user", () => {
      const { handler, session, ws } = setup();
      session.lastStatus = "running";

      handler.handleQueueMessage(session, { type: "queue_message", content: "mine" }, ws);

      // Create a second consumer
      const ws2 = createTestSocket();
      session.consumerSockets.set(ws2, {
        userId: "user-2",
        displayName: "Bob",
        role: "participant",
        sessionId: "sess-1",
      });

      handler.handleUpdateQueuedMessage(
        session,
        { type: "update_queued_message", content: "hacked" },
        ws2,
      );

      const error = findMessage(ws2, "error");
      expect(error).toBeDefined();
      expect(error.message).toContain("Only the message author");
      expect(session.queuedMessage!.content).toBe("mine"); // unchanged
    });

    it("rejects update from unregistered socket", () => {
      const { handler, session, ws } = setup();
      session.lastStatus = "running";

      handler.handleQueueMessage(session, { type: "queue_message", content: "mine" }, ws);

      const unknownWs = createTestSocket();
      handler.handleUpdateQueuedMessage(
        session,
        { type: "update_queued_message", content: "hacked" },
        unknownWs,
      );

      const error = findMessage(unknownWs, "error");
      expect(error).toBeDefined();
      expect(error.message).toContain("Only the message author");
    });

    it("is a no-op when no message is queued", () => {
      const { handler, session, ws } = setup();

      handler.handleUpdateQueuedMessage(
        session,
        { type: "update_queued_message", content: "nothing" },
        ws,
      );

      expect(ws.sentMessages).toHaveLength(0);
    });
  });

  describe("handleCancelQueuedMessage", () => {
    it("clears queue and broadcasts queued_message_cancelled", () => {
      const { handler, session, ws } = setup();
      session.lastStatus = "running";

      handler.handleQueueMessage(session, { type: "queue_message", content: "to cancel" }, ws);
      ws.sentMessages.length = 0;

      handler.handleCancelQueuedMessage(session, ws);

      expect(session.queuedMessage).toBeNull();
      const cancelled = findMessage(ws, "queued_message_cancelled");
      expect(cancelled).toBeDefined();
    });

    it("rejects cancel from a different user", () => {
      const { handler, session, ws } = setup();
      session.lastStatus = "running";

      handler.handleQueueMessage(session, { type: "queue_message", content: "mine" }, ws);

      const ws2 = createTestSocket();
      session.consumerSockets.set(ws2, {
        userId: "user-2",
        displayName: "Bob",
        role: "participant",
        sessionId: "sess-1",
      });

      handler.handleCancelQueuedMessage(session, ws2);

      const error = findMessage(ws2, "error");
      expect(error).toBeDefined();
      expect(error.message).toContain("Only the message author");
      expect(session.queuedMessage).not.toBeNull(); // still queued
    });

    it("rejects cancel from unregistered socket", () => {
      const { handler, session, ws } = setup();
      session.lastStatus = "running";

      handler.handleQueueMessage(session, { type: "queue_message", content: "mine" }, ws);

      const unknownWs = createTestSocket();
      handler.handleCancelQueuedMessage(session, unknownWs);

      const error = findMessage(unknownWs, "error");
      expect(error).toBeDefined();
      expect(error.message).toContain("Only the message author");
    });

    it("is a no-op when no message is queued", () => {
      const { handler, session, ws } = setup();

      handler.handleCancelQueuedMessage(session, ws);

      expect(ws.sentMessages).toHaveLength(0);
    });
  });

  describe("autoSendQueuedMessage", () => {
    it("sends the queued message and broadcasts queued_message_sent", () => {
      const { handler, sendUserMessage, session, ws } = setup();
      session.lastStatus = "running";

      handler.handleQueueMessage(session, { type: "queue_message", content: "auto-send me" }, ws);
      sendUserMessage.mockClear();
      ws.sentMessages.length = 0;

      handler.autoSendQueuedMessage(session);

      expect(sendUserMessage).toHaveBeenCalledWith("sess-1", "auto-send me", {
        images: undefined,
      });
      expect(session.queuedMessage).toBeNull();

      const sent = findMessage(ws, "queued_message_sent");
      expect(sent).toBeDefined();
    });

    it("includes images when the queued message has images", () => {
      const { handler, sendUserMessage, session, ws } = setup();
      session.lastStatus = "running";

      const images = [{ media_type: "image/png", data: "base64img" }];
      handler.handleQueueMessage(
        session,
        { type: "queue_message", content: "with img", images },
        ws,
      );
      sendUserMessage.mockClear();

      handler.autoSendQueuedMessage(session);

      expect(sendUserMessage).toHaveBeenCalledWith("sess-1", "with img", { images });
    });

    it("is a no-op when no message is queued", () => {
      const { handler, sendUserMessage, session } = setup();

      handler.autoSendQueuedMessage(session);

      expect(sendUserMessage).not.toHaveBeenCalled();
    });

    it("clears queuedMessage before calling sendUserMessage", () => {
      const { handler, sendUserMessage, session, ws } = setup();
      session.lastStatus = "running";

      handler.handleQueueMessage(session, { type: "queue_message", content: "race check" }, ws);

      // Capture the session state at the moment sendUserMessage is called
      let queuedAtSendTime: unknown = "not-called";
      sendUserMessage.mockImplementation(() => {
        queuedAtSendTime = session.queuedMessage;
      });

      handler.autoSendQueuedMessage(session);

      expect(queuedAtSendTime).toBeNull();
    });
  });
});
