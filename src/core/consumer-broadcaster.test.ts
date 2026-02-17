import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ConsumerIdentity } from "../interfaces/auth.js";
import type { WebSocketLike } from "../interfaces/transport.js";
import {
  createMockSession,
  createTestSocket,
  noopLogger,
} from "../testing/cli-message-factories.js";
import {
  BACKPRESSURE_THRESHOLD,
  type BroadcastCallback,
  ConsumerBroadcaster,
} from "./consumer-broadcaster.js";
import type { Session } from "./session-store.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function identity(
  role: "participant" | "observer" = "participant",
  userId = "u1",
): ConsumerIdentity {
  return { userId, displayName: `User ${userId}`, role };
}

function sessionWithConsumers(
  ...consumers: Array<{ ws: WebSocketLike; id: ConsumerIdentity }>
): Session {
  const map = new Map<WebSocketLike, ConsumerIdentity>();
  for (const c of consumers) map.set(c.ws, c.id);
  return createMockSession({ consumerSockets: map });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("ConsumerBroadcaster", () => {
  let broadcaster: ConsumerBroadcaster;
  let onBroadcast: BroadcastCallback;

  beforeEach(() => {
    onBroadcast = vi.fn();
    broadcaster = new ConsumerBroadcaster(noopLogger, onBroadcast);
  });

  // ─── broadcast() ────────────────────────────────────────────────────────

  describe("broadcast", () => {
    it("sends JSON to all consumers in session", () => {
      const ws1 = createTestSocket();
      const ws2 = createTestSocket();
      const session = sessionWithConsumers(
        { ws: ws1, id: identity() },
        { ws: ws2, id: identity("participant", "u2") },
      );
      const msg = { type: "status_change" as const, status: "idle" as const };

      broadcaster.broadcast(session, msg);

      expect(ws1.send).toHaveBeenCalledWith(JSON.stringify(msg));
      expect(ws2.send).toHaveBeenCalledWith(JSON.stringify(msg));
    });

    it("calls onBroadcast callback after sending", () => {
      const ws = createTestSocket();
      const session = sessionWithConsumers({ ws, id: identity() });
      const msg = { type: "status_change" as const, status: "idle" as const };

      broadcaster.broadcast(session, msg);

      expect(onBroadcast).toHaveBeenCalledWith("sess-1", msg);
    });

    it("skips consumers with bufferedAmount > BACKPRESSURE_THRESHOLD", () => {
      const ws = createTestSocket({
        bufferedAmount: BACKPRESSURE_THRESHOLD + 1,
      });
      const session = sessionWithConsumers({ ws, id: identity() });

      broadcaster.broadcast(session, {
        type: "status_change",
        status: "idle",
      });

      expect(ws.send).not.toHaveBeenCalled();
    });

    it("sends when bufferedAmount === BACKPRESSURE_THRESHOLD (boundary)", () => {
      const ws = createTestSocket({
        bufferedAmount: BACKPRESSURE_THRESHOLD,
      });
      const session = sessionWithConsumers({ ws, id: identity() });

      broadcaster.broadcast(session, {
        type: "status_change",
        status: "idle",
      });

      expect(ws.send).toHaveBeenCalled();
    });

    it("removes consumers that throw on send()", () => {
      const ws = createTestSocket();
      ws.send.mockImplementation(() => {
        throw new Error("connection closed");
      });
      const session = sessionWithConsumers({ ws, id: identity() });

      broadcaster.broadcast(session, {
        type: "status_change",
        status: "idle",
      });

      expect(session.consumerSockets.size).toBe(0);
    });

    it("removes only failing consumers in a mixed set", () => {
      const wsGood = createTestSocket();
      const wsBad = createTestSocket();
      wsBad.send.mockImplementation(() => {
        throw new Error("fail");
      });
      const session = sessionWithConsumers(
        { ws: wsGood, id: identity("participant", "good") },
        { ws: wsBad, id: identity("participant", "bad") },
      );

      broadcaster.broadcast(session, {
        type: "status_change",
        status: "idle",
      });

      expect(session.consumerSockets.size).toBe(1);
      expect(session.consumerSockets.has(wsGood)).toBe(true);
    });

    it("removes all consumers when all throw, still calls onBroadcast", () => {
      const ws1 = createTestSocket();
      const ws2 = createTestSocket();
      ws1.send.mockImplementation(() => {
        throw new Error("fail");
      });
      ws2.send.mockImplementation(() => {
        throw new Error("fail");
      });
      const session = sessionWithConsumers(
        { ws: ws1, id: identity() },
        { ws: ws2, id: identity("participant", "u2") },
      );

      broadcaster.broadcast(session, {
        type: "status_change",
        status: "idle",
      });

      expect(session.consumerSockets.size).toBe(0);
      expect(onBroadcast).toHaveBeenCalled();
    });

    it("is a no-op with empty consumerSockets, still calls onBroadcast", () => {
      const session = createMockSession();

      broadcaster.broadcast(session, {
        type: "status_change",
        status: "idle",
      });

      expect(onBroadcast).toHaveBeenCalled();
    });
  });

  // ─── broadcastToParticipants() ──────────────────────────────────────────

  describe("broadcastToParticipants", () => {
    it("skips observers, sends to participants only", () => {
      const wsParticipant = createTestSocket();
      const wsObserver = createTestSocket();
      const session = sessionWithConsumers(
        { ws: wsParticipant, id: identity("participant") },
        { ws: wsObserver, id: identity("observer", "obs") },
      );
      const msg = { type: "process_output" as const, stream: "stdout" as const, data: "hi" };

      broadcaster.broadcastToParticipants(session, msg);

      expect(wsParticipant.send).toHaveBeenCalledWith(JSON.stringify(msg));
      expect(wsObserver.send).not.toHaveBeenCalled();
    });

    it("removes failing participant sockets", () => {
      const ws = createTestSocket();
      ws.send.mockImplementation(() => {
        throw new Error("fail");
      });
      const session = sessionWithConsumers({ ws, id: identity() });

      broadcaster.broadcastToParticipants(session, {
        type: "status_change",
        status: "idle",
      });

      expect(session.consumerSockets.size).toBe(0);
    });

    it("sends no messages when all consumers are observers, still calls onBroadcast", () => {
      const ws = createTestSocket();
      const session = sessionWithConsumers({
        ws,
        id: identity("observer"),
      });

      broadcaster.broadcastToParticipants(session, {
        type: "status_change",
        status: "idle",
      });

      expect(ws.send).not.toHaveBeenCalled();
      expect(onBroadcast).toHaveBeenCalled();
    });
  });

  // ─── sendTo() ───────────────────────────────────────────────────────────

  describe("sendTo", () => {
    it("sends to a single socket", () => {
      const ws = createTestSocket();
      const msg = { type: "status_change" as const, status: "idle" as const };

      broadcaster.sendTo(ws, msg);

      expect(ws.send).toHaveBeenCalledWith(JSON.stringify(msg));
    });

    it("does not throw when socket throws", () => {
      const ws = createTestSocket();
      ws.send.mockImplementation(() => {
        throw new Error("fail");
      });

      expect(() => broadcaster.sendTo(ws, { type: "status_change", status: "idle" })).not.toThrow();
    });

    it("does NOT call onBroadcast", () => {
      const ws = createTestSocket();
      broadcaster.sendTo(ws, { type: "status_change", status: "idle" });
      expect(onBroadcast).not.toHaveBeenCalled();
    });
  });

  // ─── Convenience methods ────────────────────────────────────────────────

  describe("broadcastPresence", () => {
    it("broadcasts presence_update with toPresenceEntry mapping", () => {
      const ws = createTestSocket();
      const session = sessionWithConsumers({
        ws,
        id: identity("participant", "alice"),
      });

      broadcaster.broadcastPresence(session);

      const sent = JSON.parse(ws.sentMessages[0]);
      expect(sent.type).toBe("presence_update");
      expect(sent.consumers).toEqual([
        { userId: "alice", displayName: "User alice", role: "participant" },
      ]);
    });
  });

  describe("broadcastNameUpdate", () => {
    it("broadcasts session_name_update with name", () => {
      const ws = createTestSocket();
      const session = sessionWithConsumers({ ws, id: identity() });

      broadcaster.broadcastNameUpdate(session, "My Session");

      const sent = JSON.parse(ws.sentMessages[0]);
      expect(sent).toEqual({
        type: "session_name_update",
        name: "My Session",
      });
    });
  });

  describe("broadcastResumeFailed", () => {
    it("broadcasts resume_failed with sessionId", () => {
      const ws = createTestSocket();
      const session = sessionWithConsumers({ ws, id: identity() });

      broadcaster.broadcastResumeFailed(session, "sess-42");

      const sent = JSON.parse(ws.sentMessages[0]);
      expect(sent).toEqual({ type: "resume_failed", sessionId: "sess-42" });
    });
  });

  describe("broadcastProcessOutput", () => {
    it("uses participants-only path", () => {
      const wsParticipant = createTestSocket();
      const wsObserver = createTestSocket();
      const session = sessionWithConsumers(
        { ws: wsParticipant, id: identity("participant") },
        { ws: wsObserver, id: identity("observer", "obs") },
      );

      broadcaster.broadcastProcessOutput(session, "stdout", "hello");

      expect(wsParticipant.send).toHaveBeenCalled();
      expect(wsObserver.send).not.toHaveBeenCalled();
    });
  });

  describe("broadcastWatchdogState", () => {
    it("consumer receives correct JSON", () => {
      const ws = createTestSocket();
      const session = sessionWithConsumers({ ws, id: identity() });
      const watchdog = { gracePeriodMs: 5000, startedAt: 1234567890 };

      broadcaster.broadcastWatchdogState(session, watchdog);

      const sent = JSON.parse(ws.sentMessages[0]);
      expect(sent.type).toBe("session_update");
      expect(sent.session.watchdog).toEqual(watchdog);
    });
  });

  describe("broadcastCircuitBreakerState", () => {
    it("consumer receives correct JSON", () => {
      const ws = createTestSocket();
      const session = sessionWithConsumers({ ws, id: identity() });
      const cb = {
        state: "open",
        failureCount: 3,
        recoveryTimeRemainingMs: 15000,
      };

      broadcaster.broadcastCircuitBreakerState(session, cb);

      const sent = JSON.parse(ws.sentMessages[0]);
      expect(sent.type).toBe("session_update");
      expect(sent.session.circuitBreaker).toEqual(cb);
    });
  });
});
