import { beforeEach, describe, expect, it } from "vitest";
import { TokenBucketLimiter } from "../adapters/token-bucket-limiter.js";
import type { WebSocketLike } from "../interfaces/transport.js";
import { SessionBridge } from "./session-bridge.js";

// Mock WebSocket for testing
function createMockSocket(): WebSocketLike {
  const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
  return {
    send: (_data: string) => {
      // Mock send
    },
    close: () => {
      // Mock close
    },
    on: (event: string, handler: (...args: unknown[]) => void) => {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(handler);
    },
  };
}

describe("SessionBridge Integration - Rate Limiting", () => {
  let bridge: SessionBridge;
  const sessionId = "test-session-123";

  beforeEach(() => {
    bridge = new SessionBridge({
      config: {
        port: 3456,
        consumerMessageRateLimit: {
          tokensPerSecond: 10, // 10 messages per second
          burstSize: 5, // Allow 5 burst
        },
      },
      rateLimiterFactory: (burstSize, refillIntervalMs, tokensPerInterval) =>
        new TokenBucketLimiter(burstSize, refillIntervalMs, tokensPerInterval),
    });
  });

  it("allows messages within rate limit", () => {
    const socket = createMockSocket();

    // Simulate consumer connection
    const session = bridge.getOrCreateSession(sessionId);
    session.consumerSockets.set(socket, {
      userId: "user-1",
      displayName: "Test User",
      role: "participant",
    });

    // Send 3 messages - should all succeed (within burst of 5)
    for (let i = 0; i < 3; i++) {
      // Mock incoming message
      bridge.handleConsumerMessage(
        socket,
        sessionId,
        JSON.stringify({
          type: "user_message",
          content: `Message ${i}`,
        }),
      );
    }

    // All should succeed - no rate limit exceeded
    expect(session.consumerRateLimiters.size).toBe(1); // Rate limiter created
  });

  it("rejects messages exceeding rate limit", () => {
    const socket = createMockSocket();
    let rejectionMessage: string | null = null;

    // Override socket.send to capture rejection
    socket.send = (data: string) => {
      const msg = JSON.parse(data);
      if (msg.type === "error") {
        rejectionMessage = msg.message;
      }
    };

    // Simulate consumer connection
    const session = bridge.getOrCreateSession(sessionId);
    session.consumerSockets.set(socket, {
      userId: "user-1",
      displayName: "Test User",
      role: "participant",
    });

    // Send messages to exceed limit
    // With 5 burst size, after 5 messages the next ones should be rejected
    for (let i = 0; i < 10; i++) {
      bridge.handleConsumerMessage(
        socket,
        sessionId,
        JSON.stringify({
          type: "user_message",
          content: `Message ${i}`,
        }),
      );
    }

    // Some messages should have been rejected
    expect(rejectionMessage).toContain("Rate limit exceeded");
  });

  it("cleans up rate limiter on consumer disconnect", () => {
    const socket = createMockSocket();

    // Simulate consumer connection and message
    const session = bridge.getOrCreateSession(sessionId);
    session.consumerSockets.set(socket, {
      userId: "user-1",
      displayName: "Test User",
      role: "participant",
    });

    // Send a message to create rate limiter
    bridge.handleConsumerMessage(
      socket,
      sessionId,
      JSON.stringify({
        type: "user_message",
        content: "Test",
      }),
    );

    expect(session.consumerRateLimiters.size).toBe(1);

    // Simulate disconnect
    bridge.handleConsumerClose(socket, sessionId);

    // Rate limiter should be cleaned up
    expect(session.consumerRateLimiters.size).toBe(0);
  });
});
