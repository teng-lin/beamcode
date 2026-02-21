import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:crypto", () => ({ randomUUID: () => "test-uuid" }));

import { TokenBucketLimiter } from "../adapters/token-bucket-limiter.js";
import type { WebSocketLike } from "../interfaces/transport.js";
import {
  createBridgeWithAdapter,
  type MockBackendAdapter,
  type MockBackendSession,
  makePermissionRequestUnifiedMsg,
  makeResultUnifiedMsg,
  makeStatusChangeMsg,
  makeStreamEventUnifiedMsg,
  tick,
} from "../testing/adapter-test-helpers.js";
import type { SessionBridge as SessionBridgeType } from "./session-bridge.js";
import { SessionBridge } from "./session-bridge.js";

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("SessionBridge — Programmatic API", () => {
  let bridge: SessionBridgeType;
  let adapter: MockBackendAdapter;
  let backendSession: MockBackendSession;

  beforeEach(async () => {
    const created = createBridgeWithAdapter();
    bridge = created.bridge;
    adapter = created.adapter;

    // Connect backend (adapter path)
    await bridge.connectBackend("sess-1");
    backendSession = adapter.getSession("sess-1")!;
  });

  it("sendUserMessage sends unified user_message to backend", async () => {
    bridge.sendUserMessage("sess-1", "Hello world");

    expect(backendSession.sentMessages).toHaveLength(1);
    const msg = backendSession.sentMessages[0];
    expect(msg.type).toBe("user_message");
    expect(msg.role).toBe("user");
    const textBlock = msg.content.find((b) => b.type === "text");
    expect(textBlock).toBeDefined();
    expect(textBlock!.type === "text" && textBlock!.text).toBe("Hello world");
  });

  it("sendUserMessage with images sends content block array", async () => {
    bridge.sendUserMessage("sess-1", "Describe this", {
      images: [{ media_type: "image/png", data: "base64data" }],
    });

    expect(backendSession.sentMessages).toHaveLength(1);
    const msg = backendSession.sentMessages[0];
    expect(msg.type).toBe("user_message");
    expect(msg.content).toHaveLength(2);
    expect(msg.content[0].type).toBe("image");
    expect(msg.content[1].type).toBe("text");
    expect(msg.content[1].type === "text" && msg.content[1].text).toBe("Describe this");
  });

  it("sendUserMessage adds message to history", async () => {
    bridge.sendUserMessage("sess-1", "Hello");

    const snapshot = bridge.getSession("sess-1")!;
    expect(snapshot.messageHistoryLength).toBe(1);
  });

  it("sendUserMessage with sessionIdOverride uses that session_id in the message", async () => {
    bridge.sendUserMessage("sess-1", "Hello", { sessionIdOverride: "override-id" });

    expect(backendSession.sentMessages).toHaveLength(1);
    const msg = backendSession.sentMessages[0];
    expect(msg.metadata.session_id).toBe("override-id");
  });

  it("sendUserMessage is a no-op for nonexistent sessions", () => {
    expect(() => bridge.sendUserMessage("nonexistent", "hello")).not.toThrow();
  });

  it("sendPermissionResponse allows a pending permission", async () => {
    // Push a permission_request via the adapter path
    backendSession.pushMessage(makePermissionRequestUnifiedMsg());
    await tick();
    backendSession.sentMessages.length = 0;

    const resolvedHandler = vi.fn();
    bridge.on("permission:resolved", resolvedHandler);

    bridge.sendPermissionResponse("sess-1", "perm-req-1", "allow");

    expect(backendSession.sentMessages).toHaveLength(1);
    const msg = backendSession.sentMessages[0];
    expect(msg.type).toBe("permission_response");
    expect(msg.metadata.behavior).toBe("allow");
    expect(resolvedHandler).toHaveBeenCalledWith({
      sessionId: "sess-1",
      requestId: "perm-req-1",
      behavior: "allow",
    });
  });

  it("sendPermissionResponse denies a pending permission", async () => {
    backendSession.pushMessage(makePermissionRequestUnifiedMsg());
    await tick();
    backendSession.sentMessages.length = 0;

    bridge.sendPermissionResponse("sess-1", "perm-req-1", "deny", { message: "No thanks" });

    const msg = backendSession.sentMessages[0];
    expect(msg.type).toBe("permission_response");
    expect(msg.metadata.behavior).toBe("deny");
    expect(msg.metadata.message).toBe("No thanks");
  });

  it("sendPermissionResponse with unknown request_id is a no-op (S4)", async () => {
    bridge.sendPermissionResponse("sess-1", "unknown-req", "allow");

    expect(backendSession.sentMessages).toHaveLength(0);
  });

  it("sendPermissionResponse is a no-op for nonexistent sessions", () => {
    expect(() => bridge.sendPermissionResponse("nonexistent", "req-1", "allow")).not.toThrow();
  });

  it("sendInterrupt sends interrupt unified message to backend", async () => {
    bridge.sendInterrupt("sess-1");

    expect(backendSession.sentMessages).toHaveLength(1);
    const msg = backendSession.sentMessages[0];
    expect(msg.type).toBe("interrupt");
    expect(msg.role).toBe("user");
  });

  it("sendInterrupt is a no-op for nonexistent sessions", () => {
    expect(() => bridge.sendInterrupt("nonexistent")).not.toThrow();
  });

  it("sendSetModel sends configuration_change unified message to backend", async () => {
    bridge.sendSetModel("sess-1", "claude-opus-4-20250514");

    expect(backendSession.sentMessages).toHaveLength(1);
    const msg = backendSession.sentMessages[0];
    expect(msg.type).toBe("configuration_change");
    expect(msg.metadata.subtype).toBe("set_model");
    expect(msg.metadata.model).toBe("claude-opus-4-20250514");
  });

  it("sendSetModel is a no-op for nonexistent sessions", () => {
    expect(() => bridge.sendSetModel("nonexistent", "model")).not.toThrow();
  });

  it("sendSetPermissionMode sends configuration_change unified message to backend", async () => {
    bridge.sendSetPermissionMode("sess-1", "plan");

    expect(backendSession.sentMessages).toHaveLength(1);
    const msg = backendSession.sentMessages[0];
    expect(msg.type).toBe("configuration_change");
    expect(msg.metadata.subtype).toBe("set_permission_mode");
    expect(msg.metadata.mode).toBe("plan");
  });

  it("sendSetPermissionMode is a no-op for nonexistent sessions", () => {
    expect(() => bridge.sendSetPermissionMode("nonexistent", "plan")).not.toThrow();
  });
});

// ─── Rate Limiting ────────────────────────────────────────────────────────────

// Mock WebSocket for rate-limiting tests
function createRateLimitSocket(): WebSocketLike {
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
    const socket = createRateLimitSocket();

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
    const socket = createRateLimitSocket();
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
    const socket = createRateLimitSocket();

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

// ─── Lifecycle Tracking ───────────────────────────────────────────────────────

describe("SessionBridge lifecycle tracking", () => {
  it("tracks lifecycle from backend events and routed messages", async () => {
    const { bridge, adapter } = createBridgeWithAdapter();

    bridge.getOrCreateSession("life-1");
    expect(bridge.getLifecycleState("life-1")).toBe("awaiting_backend");
    expect(bridge.getSession("life-1")?.lifecycle).toBe("awaiting_backend");

    await bridge.connectBackend("life-1");
    await tick();
    expect(bridge.getLifecycleState("life-1")).toBe("active");
    expect(bridge.getSession("life-1")?.lifecycle).toBe("active");

    const backendSession = adapter.getSession("life-1");
    expect(backendSession).toBeDefined();

    backendSession!.pushMessage(makeStatusChangeMsg({ status: "idle" }));
    await tick();
    expect(bridge.getLifecycleState("life-1")).toBe("idle");

    backendSession!.pushMessage(
      makeStreamEventUnifiedMsg({
        event: { type: "message_start" },
        parent_tool_use_id: null,
      }),
    );
    await tick();
    expect(bridge.getLifecycleState("life-1")).toBe("active");

    backendSession!.pushMessage(makeResultUnifiedMsg());
    await tick();
    expect(bridge.getLifecycleState("life-1")).toBe("idle");

    await bridge.disconnectBackend("life-1");
    await tick();
    expect(bridge.getLifecycleState("life-1")).toBe("degraded");

    await bridge.closeSession("life-1");
    expect(bridge.getLifecycleState("life-1")).toBeUndefined();
  });
});
