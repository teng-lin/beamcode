import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:crypto", () => ({ randomUUID: () => "test-uuid" }));

import { MemoryStorage } from "../adapters/memory-storage.js";
import {
  createBridgeWithAdapter,
  type MockBackendAdapter,
  type MockBackendSession,
  makeAssistantUnifiedMsg,
  makePermissionRequestUnifiedMsg,
  makeResultUnifiedMsg,
  makeSessionInitMsg,
  noopLogger,
  setupInitializedSession,
  tick,
} from "../testing/adapter-test-helpers.js";
import {
  authContext,
  createTestSocket as createMockSocket,
} from "../testing/cli-message-factories.js";
import { SessionBridge } from "./session-bridge.js";

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("SessionBridge", () => {
  let bridge: SessionBridge;
  let storage: MemoryStorage;
  let adapter: MockBackendAdapter;

  beforeEach(() => {
    const created = createBridgeWithAdapter();
    bridge = created.bridge;
    storage = created.storage;
    adapter = created.adapter;
  });
  describe("Session management", () => {
    it("creates a new session with getOrCreateSession", () => {
      bridge.getOrCreateSession("sess-1");
      const snapshot = bridge.getSession("sess-1");
      expect(snapshot).toBeDefined();
      expect(snapshot!.id).toBe("sess-1");
      expect(snapshot!.state.session_id).toBe("sess-1");
      expect(snapshot!.cliConnected).toBe(false);
      expect(snapshot!.consumerCount).toBe(0);
      expect(snapshot!.pendingPermissions).toEqual([]);
      expect(snapshot!.messageHistoryLength).toBe(0);
    });

    it("returns the same session on repeated getOrCreateSession calls", () => {
      bridge.getOrCreateSession("sess-1");
      bridge.getOrCreateSession("sess-1");
      const sessions = bridge.getAllSessions();
      expect(sessions.filter((s) => s.session_id === "sess-1")).toHaveLength(1);
    });

    it("getSession returns undefined for nonexistent sessions", () => {
      expect(bridge.getSession("nonexistent")).toBeUndefined();
    });

    it("getAllSessions returns all session states", () => {
      bridge.getOrCreateSession("sess-1");
      bridge.getOrCreateSession("sess-2");
      bridge.getOrCreateSession("sess-3");
      const all = bridge.getAllSessions();
      expect(all).toHaveLength(3);
      const ids = all.map((s) => s.session_id);
      expect(ids).toContain("sess-1");
      expect(ids).toContain("sess-2");
      expect(ids).toContain("sess-3");
    });

    it("removeSession deletes a session from the bridge and storage", async () => {
      const backendSession = await setupInitializedSession(bridge, adapter, "sess-1");
      // Trigger persistence so storage has it (session_init triggers persist)
      expect(storage.load("sess-1")).not.toBeNull();

      bridge.removeSession("sess-1");
      expect(bridge.getSession("sess-1")).toBeUndefined();
      expect(storage.load("sess-1")).toBeNull();
    });

    it("closeSession closes backend session, consumer sockets, removes session, and emits event", async () => {
      await bridge.connectBackend("sess-1");
      const consumerSocket = createMockSocket();
      bridge.handleConsumerOpen(consumerSocket, authContext("sess-1"));

      const closedHandler = vi.fn();
      bridge.on("session:closed", closedHandler);

      await bridge.closeSession("sess-1");

      expect(consumerSocket.close).toHaveBeenCalled();
      expect(bridge.getSession("sess-1")).toBeUndefined();
      expect(closedHandler).toHaveBeenCalledWith({ sessionId: "sess-1" });
    });

    it("closeSession is a no-op for nonexistent sessions", async () => {
      await expect(bridge.closeSession("nonexistent")).resolves.toBeUndefined();
    });

    it("close shuts down all sessions and removes all listeners", async () => {
      await bridge.connectBackend("sess-1");
      await bridge.connectBackend("sess-2");

      await bridge.close();

      expect(bridge.getAllSessions()).toHaveLength(0);
    });

    it("isCliConnected returns false when no backend connected", () => {
      bridge.getOrCreateSession("sess-1");
      expect(bridge.isCliConnected("sess-1")).toBe(false);
    });

    it("isCliConnected returns true when backend is connected", async () => {
      await bridge.connectBackend("sess-1");
      expect(bridge.isCliConnected("sess-1")).toBe(true);
    });
  });

  // ── 2. Backend connection handlers ──────────────────────────────────────

  describe("Backend connection handlers", () => {
    it("connectBackend sets backend session and emits backend:connected", async () => {
      bridge.getOrCreateSession("sess-1");
      const handler = vi.fn();
      bridge.on("backend:connected", handler);

      await bridge.connectBackend("sess-1");

      expect(bridge.isCliConnected("sess-1")).toBe(true);
      expect(handler).toHaveBeenCalledWith({ sessionId: "sess-1" });
    });

    it("connectBackend broadcasts cli_connected to consumers", async () => {
      bridge.getOrCreateSession("sess-1");
      const consumerSocket = createMockSocket();
      bridge.handleConsumerOpen(consumerSocket, authContext("sess-1"));

      // Clear messages sent during consumer open
      consumerSocket.sentMessages.length = 0;

      await bridge.connectBackend("sess-1");

      const parsed = consumerSocket.sentMessages.map((m) => JSON.parse(m));
      expect(parsed.some((m: any) => m.type === "cli_connected")).toBe(true);
    });

    it("connectBackend flushes queued pending messages", async () => {
      bridge.getOrCreateSession("sess-1");

      // Queue a message while backend is not connected
      bridge.sendUserMessage("sess-1", "Hello");

      await bridge.connectBackend("sess-1");
      const backendSession = adapter.getSession("sess-1")!;

      // The queued user message should have been flushed via send()
      expect(backendSession.sentMessages.length).toBeGreaterThanOrEqual(1);
      const flushed = backendSession.sentMessages.some((m) => m.type === "user_message");
      expect(flushed).toBe(true);
    });

    it("backend message routes correctly to consumers", async () => {
      await bridge.connectBackend("sess-1");
      const backendSession = adapter.getSession("sess-1")!;

      const consumerSocket = createMockSocket();
      bridge.handleConsumerOpen(consumerSocket, authContext("sess-1"));
      consumerSocket.sentMessages.length = 0;

      backendSession.pushMessage(makeSessionInitMsg());
      await tick();

      const parsed = consumerSocket.sentMessages.map((m) => JSON.parse(m));
      expect(parsed.some((m: any) => m.type === "session_init")).toBe(true);
    });

    it("multiple backend messages in sequence are all routed", async () => {
      await bridge.connectBackend("sess-1");
      const backendSession = adapter.getSession("sess-1")!;

      const consumerSocket = createMockSocket();
      bridge.handleConsumerOpen(consumerSocket, authContext("sess-1"));
      consumerSocket.sentMessages.length = 0;

      backendSession.pushMessage(makeSessionInitMsg());
      await tick();
      backendSession.pushMessage(makeAssistantUnifiedMsg());
      await tick();

      const parsed = consumerSocket.sentMessages.map((m) => JSON.parse(m));
      expect(parsed.some((m: any) => m.type === "session_init")).toBe(true);
      expect(parsed.some((m: any) => m.type === "assistant")).toBe(true);
    });

    it("disconnectBackend clears backend session, emits event, and cancels pending permissions", async () => {
      await bridge.connectBackend("sess-1");
      const backendSession = adapter.getSession("sess-1")!;

      // Add a pending permission
      backendSession.pushMessage(makePermissionRequestUnifiedMsg());
      await tick();

      const consumerSocket = createMockSocket();
      bridge.handleConsumerOpen(consumerSocket, authContext("sess-1"));
      consumerSocket.sentMessages.length = 0;

      const handler = vi.fn();
      bridge.on("backend:disconnected", handler);

      await bridge.disconnectBackend("sess-1");

      expect(bridge.isCliConnected("sess-1")).toBe(false);
      expect(handler).toHaveBeenCalledWith({
        sessionId: "sess-1",
        code: 1000,
        reason: "normal",
      });

      const parsed = consumerSocket.sentMessages.map((m) => JSON.parse(m));
      expect(parsed.some((m: any) => m.type === "cli_disconnected")).toBe(true);
      expect(parsed.some((m: any) => m.type === "permission_cancelled")).toBe(true);
    });

    it("disconnectBackend is safe on nonexistent sessions", async () => {
      await expect(bridge.disconnectBackend("nonexistent")).resolves.not.toThrow();
    });
  });

  // ── 3. Consumer WebSocket handlers ─────────────────────────────────────

  describe("Consumer WebSocket handlers", () => {
    it("handleConsumerOpen sends identity then session_init snapshot", () => {
      bridge.getOrCreateSession("sess-1");
      const consumerSocket = createMockSocket();
      bridge.handleConsumerOpen(consumerSocket, authContext("sess-1"));

      const parsed = consumerSocket.sentMessages.map((m) => JSON.parse(m));
      expect(parsed[0].type).toBe("identity");
      expect(parsed[0].userId).toBe("anonymous-1");
      expect(parsed[0].displayName).toBe("User 1");
      expect(parsed[0].role).toBe("participant");
      expect(parsed[1].type).toBe("session_init");
      expect(parsed[1].session.session_id).toBe("sess-1");
    });

    it("handleConsumerOpen replays message history", async () => {
      await bridge.connectBackend("sess-1");
      const backendSession = adapter.getSession("sess-1")!;

      // Build up some message history
      backendSession.pushMessage(makeAssistantUnifiedMsg());
      await tick();

      const consumerSocket = createMockSocket();
      bridge.handleConsumerOpen(consumerSocket, authContext("sess-1"));

      const parsed = consumerSocket.sentMessages.map((m) => JSON.parse(m));
      const historyMsg = parsed.find((m: any) => m.type === "message_history");
      expect(historyMsg).toBeDefined();
      expect(historyMsg.messages.length).toBeGreaterThan(0);
    });

    it("handleConsumerOpen does not send message_history when history is empty", () => {
      bridge.getOrCreateSession("sess-1");
      const consumerSocket = createMockSocket();
      bridge.handleConsumerOpen(consumerSocket, authContext("sess-1"));

      const parsed = consumerSocket.sentMessages.map((m) => JSON.parse(m));
      expect(parsed.find((m: any) => m.type === "message_history")).toBeUndefined();
    });

    it("handleConsumerOpen sends pending permission requests", async () => {
      await bridge.connectBackend("sess-1");
      const backendSession = adapter.getSession("sess-1")!;

      backendSession.pushMessage(makePermissionRequestUnifiedMsg());
      await tick();

      const consumerSocket = createMockSocket();
      bridge.handleConsumerOpen(consumerSocket, authContext("sess-1"));

      const parsed = consumerSocket.sentMessages.map((m) => JSON.parse(m));
      expect(parsed.some((m: any) => m.type === "permission_request")).toBe(true);
    });

    it("handleConsumerOpen sends cli_disconnected and emits relaunch_needed when backend is not connected", () => {
      bridge.getOrCreateSession("sess-1");
      const relaunchHandler = vi.fn();
      bridge.on("backend:relaunch_needed", relaunchHandler);

      const consumerSocket = createMockSocket();
      bridge.handleConsumerOpen(consumerSocket, authContext("sess-1"));

      const parsed = consumerSocket.sentMessages.map((m) => JSON.parse(m));
      expect(parsed.some((m: any) => m.type === "cli_disconnected")).toBe(true);
      expect(relaunchHandler).toHaveBeenCalledWith({ sessionId: "sess-1" });
    });

    it("handleConsumerOpen emits consumer:connected with count", () => {
      bridge.getOrCreateSession("sess-1");
      const handler = vi.fn();
      bridge.on("consumer:connected", handler);

      const ws1 = createMockSocket();
      bridge.handleConsumerOpen(ws1, authContext("sess-1"));
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: "sess-1", consumerCount: 1 }),
      );

      const ws2 = createMockSocket();
      bridge.handleConsumerOpen(ws2, authContext("sess-1"));
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: "sess-1", consumerCount: 2 }),
      );
    });

    it("handleConsumerMessage routes user_message to backend", async () => {
      await bridge.connectBackend("sess-1");
      const backendSession = adapter.getSession("sess-1")!;

      const consumerSocket = createMockSocket();
      bridge.handleConsumerOpen(consumerSocket, authContext("sess-1"));

      bridge.handleConsumerMessage(
        consumerSocket,
        "sess-1",
        JSON.stringify({ type: "user_message", content: "Hello from consumer" }),
      );

      // In the adapter path, sendUserMessage sends a UnifiedMessage via backendSession.send()
      const userMsg = backendSession.sentMessages.find((m) => m.type === "user_message");
      expect(userMsg).toBeDefined();
      expect(
        userMsg!.content.some((b) => b.type === "text" && b.text === "Hello from consumer"),
      ).toBe(true);
    });

    it("handleConsumerMessage emits message:inbound event", async () => {
      await bridge.connectBackend("sess-1");

      const consumerSocket = createMockSocket();
      bridge.handleConsumerOpen(consumerSocket, authContext("sess-1"));

      const handler = vi.fn();
      bridge.on("message:inbound", handler);

      bridge.handleConsumerMessage(
        consumerSocket,
        "sess-1",
        JSON.stringify({ type: "user_message", content: "test" }),
      );

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: "sess-1",
          message: expect.objectContaining({ type: "user_message", content: "test" }),
        }),
      );
    });

    it("handleConsumerMessage ignores messages for nonexistent sessions", () => {
      const ws = createMockSocket();
      expect(() =>
        bridge.handleConsumerMessage(
          ws,
          "no-such",
          JSON.stringify({ type: "user_message", content: "x" }),
        ),
      ).not.toThrow();
    });

    it("handleConsumerMessage ignores malformed JSON", () => {
      bridge.getOrCreateSession("sess-1");
      const ws = createMockSocket();
      bridge.handleConsumerOpen(ws, authContext("sess-1"));
      expect(() => bridge.handleConsumerMessage(ws, "sess-1", "not-json-at-all")).not.toThrow();
    });

    it("handleConsumerClose removes consumer and emits event", () => {
      bridge.getOrCreateSession("sess-1");
      const ws = createMockSocket();
      bridge.handleConsumerOpen(ws, authContext("sess-1"));

      const handler = vi.fn();
      bridge.on("consumer:disconnected", handler);

      bridge.handleConsumerClose(ws, "sess-1");

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: "sess-1", consumerCount: 0 }),
      );
      expect(bridge.getSession("sess-1")!.consumerCount).toBe(0);
    });

    it("handleConsumerClose is safe on nonexistent sessions", () => {
      const ws = createMockSocket();
      expect(() => bridge.handleConsumerClose(ws, "nonexistent")).not.toThrow();
    });
  });

  // ── 6. Consumer message routing ────────────────────────────────────────

  describe("Consumer message routing", () => {
    let backendSession: MockBackendSession;
    let consumerWs: ReturnType<typeof createMockSocket>;

    beforeEach(async () => {
      await bridge.connectBackend("sess-1");
      backendSession = adapter.getSession("sess-1")!;
      consumerWs = createMockSocket();
      bridge.handleConsumerOpen(consumerWs, authContext("sess-1"));
      backendSession.sentMessages.length = 0;
    });

    it("user_message routes through sendUserMessage to backend", () => {
      bridge.handleConsumerMessage(
        consumerWs,
        "sess-1",
        JSON.stringify({ type: "user_message", content: "Hello!" }),
      );

      const userMsg = backendSession.sentMessages.find((m) => m.type === "user_message");
      expect(userMsg).toBeDefined();
      expect(userMsg!.content.some((b) => b.type === "text" && b.text === "Hello!")).toBe(true);
    });

    it("permission_response routes through sendPermissionResponse", async () => {
      backendSession.pushMessage(makePermissionRequestUnifiedMsg());
      await tick();
      backendSession.sentMessages.length = 0;

      bridge.handleConsumerMessage(
        consumerWs,
        "sess-1",
        JSON.stringify({
          type: "permission_response",
          request_id: "perm-req-1",
          behavior: "allow",
        }),
      );

      // In the adapter path, sendPermissionResponse sends a UnifiedMessage
      const permMsg = backendSession.sentMessages.find((m) => m.type === "permission_response");
      expect(permMsg).toBeDefined();
    });

    it("interrupt routes through sendInterrupt", () => {
      bridge.handleConsumerMessage(consumerWs, "sess-1", JSON.stringify({ type: "interrupt" }));

      const interruptMsg = backendSession.sentMessages.find((m) => m.type === "interrupt");
      expect(interruptMsg).toBeDefined();
    });

    it("set_model routes through sendSetModel", () => {
      bridge.handleConsumerMessage(
        consumerWs,
        "sess-1",
        JSON.stringify({ type: "set_model", model: "claude-opus-4-20250514" }),
      );

      // In the adapter path, set_model is normalized to configuration_change
      const setModelMsg = backendSession.sentMessages.find(
        (m) => m.type === "configuration_change" && m.metadata.subtype === "set_model",
      );
      expect(setModelMsg).toBeDefined();
      expect(setModelMsg!.metadata.model).toBe("claude-opus-4-20250514");
    });

    it("set_permission_mode routes through sendSetPermissionMode", () => {
      bridge.handleConsumerMessage(
        consumerWs,
        "sess-1",
        JSON.stringify({ type: "set_permission_mode", mode: "bypassPermissions" }),
      );

      // In the adapter path, set_permission_mode is normalized to configuration_change
      const setModeMsg = backendSession.sentMessages.find(
        (m) => m.type === "configuration_change" && m.metadata.subtype === "set_permission_mode",
      );
      expect(setModeMsg).toBeDefined();
      expect(setModeMsg!.metadata.mode).toBe("bypassPermissions");
    });

    it("set_adapter returns an error message to the consumer", () => {
      bridge.handleConsumerMessage(
        consumerWs,
        "sess-1",
        JSON.stringify({ type: "set_adapter", adapter: "codex" }),
      );
      const errorMsg = (consumerWs.send as ReturnType<typeof vi.fn>).mock.calls.find(
        ([raw]: [string]) => {
          const parsed = JSON.parse(raw);
          return parsed.type === "error";
        },
      );
      expect(errorMsg).toBeDefined();
      const parsed = JSON.parse(errorMsg![0]);
      expect(parsed.message).toMatch(/cannot be changed/i);
    });
  });

});
