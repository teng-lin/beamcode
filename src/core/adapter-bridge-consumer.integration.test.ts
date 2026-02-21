import { beforeEach, describe, expect, it } from "vitest";
import { TokenBucketLimiter } from "../adapters/token-bucket-limiter.js";
import type { WebSocketLike } from "../interfaces/transport.js";
import {
  createBridgeWithAdapter,
  type MockBackendAdapter,
  makeAssistantUnifiedMsg,
  makeResultUnifiedMsg,
  tick,
} from "../testing/adapter-test-helpers.js";
import type { SessionBridge } from "./session-bridge.js";
import { createUnifiedMessage } from "./types/unified-message.js";

// ── Mock WebSocket ───────────────────────────────────────────────────────────

interface MockSocket extends WebSocketLike {
  sentMessages: string[];
  closed: boolean;
}

function createMockSocket(): MockSocket {
  const socket: MockSocket = {
    sentMessages: [],
    closed: false,
    send(data: string) {
      socket.sentMessages.push(data);
    },
    close() {
      socket.closed = true;
    },
  };
  return socket;
}

/** Parse all JSON messages sent to a mock socket. */
function parseSent(socket: MockSocket): unknown[] {
  return socket.sentMessages.map((m) => JSON.parse(m));
}

/** Find sent messages of a specific type. */
function sentOfType(socket: MockSocket, type: string): unknown[] {
  return parseSent(socket).filter((m: unknown) => (m as { type: string }).type === type);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("Adapter → SessionBridge → Consumer Integration", () => {
  let bridge: SessionBridge;
  let adapter: MockBackendAdapter;
  const sessionId = "integration-session-1";

  beforeEach(() => {
    const created = createBridgeWithAdapter({
      config: {
        port: 3456,
        consumerMessageRateLimit: {
          tokensPerSecond: 10,
          burstSize: 5,
        },
      },
      rateLimiterFactory: (burstSize, refillIntervalMs, tokensPerInterval) =>
        new TokenBucketLimiter(burstSize, refillIntervalMs, tokensPerInterval),
    });
    bridge = created.bridge;
    adapter = created.adapter;
    bridge.getOrCreateSession(sessionId);
  });

  // ── 1. Basic flow ────────────────────────────────────────────────────────

  describe("basic flow through SessionBridge", () => {
    it("connects a consumer and delivers identity + session_init", () => {
      const socket = createMockSocket();

      bridge.handleConsumerOpen(socket, { sessionId, transport: {} });

      const messages = parseSent(socket);
      const types = messages.map((m: unknown) => (m as { type: string }).type);

      expect(types).toContain("identity");
      expect(types).toContain("session_init");
      expect(types).toContain("presence_update");

      // Identity should be anonymous (no authenticator)
      const identity = messages.find(
        (m: unknown) => (m as { type: string }).type === "identity",
      ) as { userId: string; role: string };
      expect(identity.userId).toMatch(/^anonymous-/);
      expect(identity.role).toBe("participant");
    });

    it("consumer also gets cli_disconnected when CLI is not connected", () => {
      const socket = createMockSocket();

      bridge.handleConsumerOpen(socket, { sessionId, transport: {} });

      const types = parseSent(socket).map((m: unknown) => (m as { type: string }).type);
      expect(types).toContain("cli_disconnected");
    });

    it("routes user_message from consumer and stores in message history", () => {
      const socket = createMockSocket();
      bridge.handleConsumerOpen(socket, { sessionId, transport: {} });

      bridge.handleConsumerMessage(
        socket,
        sessionId,
        JSON.stringify({ type: "user_message", content: "Hello world" }),
      );

      const snapshot = bridge.getSession(sessionId);
      expect(snapshot).toBeDefined();
      expect(snapshot!.messageHistoryLength).toBe(1);
    });

    it("updates lastActivity on consumer message", () => {
      const socket = createMockSocket();
      bridge.handleConsumerOpen(socket, { sessionId, transport: {} });

      const before = Date.now();
      bridge.handleConsumerMessage(
        socket,
        sessionId,
        JSON.stringify({ type: "user_message", content: "ping" }),
      );

      const snapshot = bridge.getSession(sessionId);
      expect(snapshot!.lastActivity).toBeGreaterThanOrEqual(before);
    });
  });

  // ── 2. Multiple consumers on one session ─────────────────────────────────

  describe("multiple consumers on one session", () => {
    it("broadcasts backend messages to all connected consumers", async () => {
      const socket1 = createMockSocket();
      const socket2 = createMockSocket();

      // Connect both consumers
      bridge.handleConsumerOpen(socket1, { sessionId, transport: {} });
      bridge.handleConsumerOpen(socket2, { sessionId, transport: {} });

      // Connect backend (replaces handleCLIOpen)
      await bridge.connectBackend(sessionId);
      const backendSession = adapter.getSession(sessionId)!;

      // Clear sent messages to focus on backend broadcast
      socket1.sentMessages.length = 0;
      socket2.sentMessages.length = 0;

      // Simulate backend sending an assistant message via adapter path
      backendSession.pushMessage(
        makeAssistantUnifiedMsg({
          message_id: "msg-1",
          model: "claude-sonnet-4-5-20250929",
        }),
      );
      await tick();

      // Both consumers should receive the assistant message
      const s1Assistant = sentOfType(socket1, "assistant");
      const s2Assistant = sentOfType(socket2, "assistant");
      expect(s1Assistant).toHaveLength(1);
      expect(s2Assistant).toHaveLength(1);
    });

    it("sends presence_update to all consumers when a new one connects", () => {
      const socket1 = createMockSocket();
      bridge.handleConsumerOpen(socket1, { sessionId, transport: {} });

      // Clear socket1 messages before second consumer connects
      socket1.sentMessages.length = 0;

      const socket2 = createMockSocket();
      bridge.handleConsumerOpen(socket2, { sessionId, transport: {} });

      // socket1 should receive a presence_update with 2 consumers
      const presenceUpdates = sentOfType(socket1, "presence_update") as Array<{
        consumers: unknown[];
      }>;
      expect(presenceUpdates.length).toBeGreaterThanOrEqual(1);
      const lastUpdate = presenceUpdates[presenceUpdates.length - 1];
      expect(lastUpdate.consumers).toHaveLength(2);
    });

    it("tracks consumer count accurately", () => {
      const socket1 = createMockSocket();
      const socket2 = createMockSocket();

      bridge.handleConsumerOpen(socket1, { sessionId, transport: {} });
      expect(bridge.getSession(sessionId)!.consumerCount).toBe(1);

      bridge.handleConsumerOpen(socket2, { sessionId, transport: {} });
      expect(bridge.getSession(sessionId)!.consumerCount).toBe(2);
    });
  });

  // ── 3. Consumer disconnect cleanup ────────────────────────────────────────

  describe("consumer disconnect cleanup", () => {
    it("removes consumer socket and rate limiter on disconnect", () => {
      const socket = createMockSocket();
      bridge.handleConsumerOpen(socket, { sessionId, transport: {} });

      // Send a message to create a rate limiter
      bridge.handleConsumerMessage(
        socket,
        sessionId,
        JSON.stringify({ type: "user_message", content: "test" }),
      );

      expect(bridge.getSession(sessionId)!.consumerCount).toBe(1);

      // Disconnect
      bridge.handleConsumerClose(socket, sessionId);

      const snapshot = bridge.getSession(sessionId)!;
      expect(snapshot.consumerCount).toBe(0);
    });

    it("emits consumer:disconnected event on close", () => {
      const socket = createMockSocket();
      bridge.handleConsumerOpen(socket, { sessionId, transport: {} });

      const events: unknown[] = [];
      bridge.on("consumer:disconnected", (e) => events.push(e));

      bridge.handleConsumerClose(socket, sessionId);

      expect(events).toHaveLength(1);
      expect((events[0] as { consumerCount: number }).consumerCount).toBe(0);
    });

    it("broadcasts presence_update after disconnect", () => {
      const socket1 = createMockSocket();
      const socket2 = createMockSocket();

      bridge.handleConsumerOpen(socket1, { sessionId, transport: {} });
      bridge.handleConsumerOpen(socket2, { sessionId, transport: {} });

      // Clear to focus on disconnect broadcast
      socket2.sentMessages.length = 0;

      bridge.handleConsumerClose(socket1, sessionId);

      // socket2 should get presence_update with 1 consumer
      const presenceUpdates = sentOfType(socket2, "presence_update") as Array<{
        consumers: unknown[];
      }>;
      expect(presenceUpdates.length).toBeGreaterThanOrEqual(1);
      const lastUpdate = presenceUpdates[presenceUpdates.length - 1];
      expect(lastUpdate.consumers).toHaveLength(1);
    });

    it("handles disconnect for non-existent session gracefully", () => {
      const socket = createMockSocket();
      // Should not throw
      expect(() => bridge.handleConsumerClose(socket, "non-existent")).not.toThrow();
    });
  });

  // ── 4. Rate limiting integration ──────────────────────────────────────────

  describe("rate limiting integration", () => {
    it("allows messages within burst limit", () => {
      const socket = createMockSocket();
      bridge.handleConsumerOpen(socket, { sessionId, transport: {} });

      // Clear initial messages
      socket.sentMessages.length = 0;

      // Send 5 messages (burst limit)
      for (let i = 0; i < 5; i++) {
        bridge.handleConsumerMessage(
          socket,
          sessionId,
          JSON.stringify({ type: "user_message", content: `msg-${i}` }),
        );
      }

      // No error messages should have been sent
      const errors = sentOfType(socket, "error");
      expect(errors).toHaveLength(0);
    });

    it("rejects messages exceeding burst limit", () => {
      const socket = createMockSocket();
      bridge.handleConsumerOpen(socket, { sessionId, transport: {} });

      // Clear initial messages
      socket.sentMessages.length = 0;

      // Send more than burst limit (5)
      for (let i = 0; i < 10; i++) {
        bridge.handleConsumerMessage(
          socket,
          sessionId,
          JSON.stringify({ type: "user_message", content: `msg-${i}` }),
        );
      }

      const errors = sentOfType(socket, "error") as Array<{ message: string }>;
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].message).toContain("Rate limit exceeded");
    });

    it("rate limits are per-consumer, not per-session", () => {
      const socket1 = createMockSocket();
      const socket2 = createMockSocket();

      bridge.handleConsumerOpen(socket1, { sessionId, transport: {} });
      bridge.handleConsumerOpen(socket2, { sessionId, transport: {} });

      // Clear initial messages
      socket1.sentMessages.length = 0;
      socket2.sentMessages.length = 0;

      // Exhaust socket1's burst
      for (let i = 0; i < 10; i++) {
        bridge.handleConsumerMessage(
          socket1,
          sessionId,
          JSON.stringify({ type: "user_message", content: `msg-${i}` }),
        );
      }

      // socket2 should still be able to send
      bridge.handleConsumerMessage(
        socket2,
        sessionId,
        JSON.stringify({ type: "user_message", content: "from socket2" }),
      );

      const s2Errors = sentOfType(socket2, "error");
      expect(s2Errors).toHaveLength(0);
    });
  });

  // ── 5. Session isolation ──────────────────────────────────────────────────

  describe("session isolation", () => {
    const sessionId2 = "integration-session-2";

    it("messages do not leak between sessions", async () => {
      bridge.getOrCreateSession(sessionId2);
      const socket1 = createMockSocket();
      const socket2 = createMockSocket();

      // Connect consumers to different sessions
      bridge.handleConsumerOpen(socket1, { sessionId, transport: {} });
      bridge.handleConsumerOpen(socket2, { sessionId: sessionId2, transport: {} });

      // Connect backend sessions (replaces handleCLIOpen for both sessions)
      await bridge.connectBackend(sessionId);
      await bridge.connectBackend(sessionId2);
      const backendSession1 = adapter.getSession(sessionId)!;

      // Clear all messages
      socket1.sentMessages.length = 0;
      socket2.sentMessages.length = 0;

      // Simulate backend message only on session 1 via adapter path
      backendSession1.pushMessage(
        makeAssistantUnifiedMsg({
          message_id: "msg-s1",
          model: "claude-sonnet-4-5-20250929",
        }),
      );
      await tick();

      // socket1 should get the message
      expect(sentOfType(socket1, "assistant")).toHaveLength(1);
      // socket2 should NOT get the message
      expect(sentOfType(socket2, "assistant")).toHaveLength(0);
    });

    it("session state is independent", () => {
      bridge.getOrCreateSession(sessionId);
      bridge.getOrCreateSession(sessionId2);

      const s1 = bridge.getSession(sessionId)!;
      const s2 = bridge.getSession(sessionId2)!;

      expect(s1.id).toBe(sessionId);
      expect(s2.id).toBe(sessionId2);
      expect(s1.state.session_id).toBe(sessionId);
      expect(s2.state.session_id).toBe(sessionId2);
    });

    it("consumer counts are independent per session", () => {
      bridge.getOrCreateSession(sessionId2);
      const socket1 = createMockSocket();
      const socket2 = createMockSocket();
      const socket3 = createMockSocket();

      bridge.handleConsumerOpen(socket1, { sessionId, transport: {} });
      bridge.handleConsumerOpen(socket2, { sessionId, transport: {} });
      bridge.handleConsumerOpen(socket3, { sessionId: sessionId2, transport: {} });

      expect(bridge.getSession(sessionId)!.consumerCount).toBe(2);
      expect(bridge.getSession(sessionId2)!.consumerCount).toBe(1);
    });
  });

  // ── 6. Error handling ─────────────────────────────────────────────────────

  describe("error handling", () => {
    it("handles malformed JSON gracefully without crashing", () => {
      const socket = createMockSocket();
      bridge.handleConsumerOpen(socket, { sessionId, transport: {} });

      // Send malformed JSON — should not throw
      expect(() => {
        bridge.handleConsumerMessage(socket, sessionId, "not valid json {{{");
      }).not.toThrow();

      // Session should still be valid
      const snapshot = bridge.getSession(sessionId);
      expect(snapshot).toBeDefined();
      expect(snapshot!.consumerCount).toBe(1);
    });

    it("ignores messages from unregistered sockets", () => {
      const registeredSocket = createMockSocket();
      const unregisteredSocket = createMockSocket();

      bridge.handleConsumerOpen(registeredSocket, { sessionId, transport: {} });

      // Send message from unregistered socket — should be silently ignored
      expect(() => {
        bridge.handleConsumerMessage(
          unregisteredSocket,
          sessionId,
          JSON.stringify({ type: "user_message", content: "sneaky" }),
        );
      }).not.toThrow();

      // No error message sent to unregistered socket
      expect(unregisteredSocket.sentMessages).toHaveLength(0);
    });

    it("handles message to non-existent session gracefully", () => {
      const socket = createMockSocket();
      expect(() => {
        bridge.handleConsumerMessage(
          socket,
          "non-existent-session",
          JSON.stringify({ type: "user_message", content: "hello" }),
        );
      }).not.toThrow();
    });

    it("observers cannot send participant-only messages", () => {
      const socket = createMockSocket();
      bridge.handleConsumerOpen(socket, { sessionId, transport: {} });

      // Override the identity to observer
      const session = bridge.getOrCreateSession(sessionId);
      session.consumerSockets.set(socket, {
        userId: "observer-1",
        displayName: "Observer",
        role: "observer",
      });

      // Clear messages
      socket.sentMessages.length = 0;

      // Try to send a user_message (participant-only)
      bridge.handleConsumerMessage(
        socket,
        sessionId,
        JSON.stringify({ type: "user_message", content: "should be blocked" }),
      );

      const errors = sentOfType(socket, "error") as Array<{ message: string }>;
      expect(errors).toHaveLength(1);
      expect(errors[0].message).toContain("Observers cannot send");
    });
  });

  // ── 7. Content type round-trip ───────────────────────────────────────────

  describe("content type round-trip through adapter path", () => {
    it("image content block reaches consumer with flattened source", async () => {
      const socket = createMockSocket();
      bridge.handleConsumerOpen(socket, { sessionId, transport: {} });
      await bridge.connectBackend(sessionId);
      const backendSession = adapter.getSession(sessionId)!;

      socket.sentMessages.length = 0;

      backendSession.pushMessage(
        createUnifiedMessage({
          type: "assistant",
          role: "assistant",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "iVBOR..." },
            },
          ],
          metadata: {
            message_id: "msg-img-rt",
            model: "claude-sonnet-4-5-20250929",
            stop_reason: "end_turn",
            parent_tool_use_id: null,
            usage: {
              input_tokens: 10,
              output_tokens: 20,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
            },
          },
        }),
      );
      await tick();

      const assistantMsgs = sentOfType(socket, "assistant") as any[];
      expect(assistantMsgs).toHaveLength(1);
      expect(assistantMsgs[0].message.content).toEqual([
        { type: "image", media_type: "image/png", data: "iVBOR..." },
      ]);
    });

    it("code content block reaches consumer", async () => {
      const socket = createMockSocket();
      bridge.handleConsumerOpen(socket, { sessionId, transport: {} });
      await bridge.connectBackend(sessionId);
      const backendSession = adapter.getSession(sessionId)!;

      socket.sentMessages.length = 0;

      backendSession.pushMessage(
        createUnifiedMessage({
          type: "assistant",
          role: "assistant",
          content: [{ type: "code", language: "typescript", code: "const x = 1;" }],
          metadata: {
            message_id: "msg-code-rt",
            model: "claude-sonnet-4-5-20250929",
            stop_reason: "end_turn",
            parent_tool_use_id: null,
            usage: {
              input_tokens: 10,
              output_tokens: 20,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
            },
          },
        }),
      );
      await tick();

      const assistantMsgs = sentOfType(socket, "assistant") as any[];
      expect(assistantMsgs).toHaveLength(1);
      expect(assistantMsgs[0].message.content).toEqual([
        { type: "code", language: "typescript", code: "const x = 1;" },
      ]);
    });

    it("refusal content block reaches consumer", async () => {
      const socket = createMockSocket();
      bridge.handleConsumerOpen(socket, { sessionId, transport: {} });
      await bridge.connectBackend(sessionId);
      const backendSession = adapter.getSession(sessionId)!;

      socket.sentMessages.length = 0;

      backendSession.pushMessage(
        createUnifiedMessage({
          type: "assistant",
          role: "assistant",
          content: [{ type: "refusal", refusal: "I cannot assist with that." }],
          metadata: {
            message_id: "msg-ref-rt",
            model: "claude-sonnet-4-5-20250929",
            stop_reason: "end_turn",
            parent_tool_use_id: null,
            usage: {
              input_tokens: 10,
              output_tokens: 20,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
            },
          },
        }),
      );
      await tick();

      const assistantMsgs = sentOfType(socket, "assistant") as any[];
      expect(assistantMsgs).toHaveLength(1);
      expect(assistantMsgs[0].message.content).toEqual([
        { type: "refusal", refusal: "I cannot assist with that." },
      ]);
    });
  });

  // ── Full round-trip flow ──────────────────────────────────────────────────

  describe("full round-trip: consumer → backend → consumer", () => {
    it("consumer message is stored and backend response reaches consumer", async () => {
      const consumerSocket = createMockSocket();

      // Connect consumer, then backend (replaces handleCLIOpen)
      bridge.handleConsumerOpen(consumerSocket, { sessionId, transport: {} });
      await bridge.connectBackend(sessionId);
      const backendSession = adapter.getSession(sessionId)!;

      // Consumer sends a user_message
      bridge.handleConsumerMessage(
        consumerSocket,
        sessionId,
        JSON.stringify({ type: "user_message", content: "What is 2+2?" }),
      );

      // Backend session should have received the message via send()
      expect(backendSession.sentMessages.length).toBeGreaterThan(0);
      const sentMsg = backendSession.sentMessages[0];
      expect(sentMsg.type).toBe("user_message");

      // Clear consumer messages
      consumerSocket.sentMessages.length = 0;

      // Simulate backend responding with a result via adapter path
      backendSession.pushMessage(
        makeResultUnifiedMsg({
          result: "4",
          duration_ms: 100,
          duration_api_ms: 80,
          num_turns: 1,
          total_cost_usd: 0.01,
        }),
      );
      await tick();

      // Consumer should receive the result
      const results = sentOfType(consumerSocket, "result");
      expect(results).toHaveLength(1);
    });

    it("queues consumer messages when backend is not yet connected", async () => {
      const consumerSocket = createMockSocket();
      bridge.handleConsumerOpen(consumerSocket, { sessionId, transport: {} });

      // Send message before backend connects
      bridge.handleConsumerMessage(
        consumerSocket,
        sessionId,
        JSON.stringify({ type: "user_message", content: "queued message" }),
      );

      // Now connect backend (replaces handleCLIOpen)
      await bridge.connectBackend(sessionId);
      const backendSession = adapter.getSession(sessionId)!;

      // Backend session should have received the queued message
      // Pending messages are flushed via backendSession.send() on connect
      expect(backendSession.sentMessages.length).toBeGreaterThan(0);
      expect(backendSession.sentMessages[0].type).toBe("user_message");
    });
  });
});
