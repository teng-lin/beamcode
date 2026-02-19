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

  // ── 1. Session management ───────────────────────────────────────────────

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

  // ── 7. Persistence ─────────────────────────────────────────────────────

  describe("Persistence", () => {
    it("restoreFromStorage loads persisted sessions", () => {
      // Persist a session manually into storage
      storage.save({
        id: "restored-sess",
        state: {
          session_id: "restored-sess",
          model: "claude-sonnet-4-5-20250929",
          cwd: "/restored",
          tools: ["Bash"],
          permissionMode: "default",
          claude_code_version: "1.0",
          mcp_servers: [],
          agents: [],
          slash_commands: [],
          skills: [],
          total_cost_usd: 0.5,
          num_turns: 10,
          context_used_percent: 25,
          is_compacting: false,
          git_branch: "main",
          is_worktree: false,
          repo_root: "/repo",
          git_ahead: 0,
          git_behind: 0,
          total_lines_added: 100,
          total_lines_removed: 50,
        },
        messageHistory: [{ type: "user_message", content: "hi", timestamp: 12345 }],
        pendingMessages: [],
        pendingPermissions: [],
      });

      const count = bridge.restoreFromStorage();
      expect(count).toBe(1);

      const snapshot = bridge.getSession("restored-sess");
      expect(snapshot).toBeDefined();
      expect(snapshot!.state.model).toBe("claude-sonnet-4-5-20250929");
      expect(snapshot!.state.cwd).toBe("/restored");
      expect(snapshot!.messageHistoryLength).toBe(1);
    });

    it("restoreFromStorage returns 0 when storage is empty", () => {
      const count = bridge.restoreFromStorage();
      expect(count).toBe(0);
    });

    it("restoreFromStorage does not overwrite live sessions", async () => {
      const backendSession = await setupInitializedSession(bridge, adapter, "sess-1");

      // Push a session_init with a specific cwd to establish state
      // (setupInitializedSession already pushes session_init with cwd: "/test")

      // Now put a different version in storage
      storage.save({
        id: "sess-1",
        state: {
          session_id: "sess-1",
          model: "old-model",
          cwd: "/old",
          tools: [],
          permissionMode: "default",
          claude_code_version: "0.1",
          mcp_servers: [],
          agents: [],
          slash_commands: [],
          skills: [],
          total_cost_usd: 0,
          num_turns: 0,
          context_used_percent: 0,
          is_compacting: false,
          git_branch: "",
          is_worktree: false,
          repo_root: "",
          git_ahead: 0,
          git_behind: 0,
          total_lines_added: 0,
          total_lines_removed: 0,
        },
        messageHistory: [],
        pendingMessages: [],
        pendingPermissions: [],
      });

      const count = bridge.restoreFromStorage();
      expect(count).toBe(0);
      // Live session should still have the current cwd
      expect(bridge.getSession("sess-1")!.state.cwd).toBe("/test");
    });

    it("restoreFromStorage returns 0 when bridge has no storage", () => {
      const noStorageBridge = new SessionBridge({ config: { port: 3456 }, logger: noopLogger });
      const count = noStorageBridge.restoreFromStorage();
      expect(count).toBe(0);
    });

    it("persistSession is triggered by system init", async () => {
      await bridge.connectBackend("sess-1");
      const backendSession = adapter.getSession("sess-1")!;

      backendSession.pushMessage(makeSessionInitMsg());
      await tick();

      const persisted = storage.load("sess-1");
      expect(persisted).not.toBeNull();
      expect(persisted!.state.model).toBe("claude-sonnet-4-5-20250929");
    });

    it("persistSession is triggered by assistant message", async () => {
      await bridge.connectBackend("sess-1");
      const backendSession = adapter.getSession("sess-1")!;

      backendSession.pushMessage(makeAssistantUnifiedMsg());
      await tick();

      const persisted = storage.load("sess-1");
      expect(persisted).not.toBeNull();
      expect(persisted!.messageHistory.length).toBeGreaterThan(0);
    });

    it("persistSession is triggered by result message", async () => {
      await bridge.connectBackend("sess-1");
      const backendSession = adapter.getSession("sess-1")!;

      backendSession.pushMessage(makeResultUnifiedMsg());
      await tick();

      const persisted = storage.load("sess-1");
      expect(persisted).not.toBeNull();
      expect(persisted!.state.total_cost_usd).toBe(0.01);
    });

    it("persistSession is triggered by permission_request", async () => {
      await bridge.connectBackend("sess-1");
      const backendSession = adapter.getSession("sess-1")!;

      backendSession.pushMessage(makePermissionRequestUnifiedMsg());
      await tick();

      const persisted = storage.load("sess-1");
      expect(persisted).not.toBeNull();
      expect(persisted!.pendingPermissions.length).toBe(1);
    });

    it("persistSession is triggered by sendUserMessage", async () => {
      await bridge.connectBackend("sess-1");

      bridge.sendUserMessage("sess-1", "Hello");

      const persisted = storage.load("sess-1");
      expect(persisted).not.toBeNull();
      expect(persisted!.messageHistory.some((m) => m.type === "user_message")).toBe(true);
    });

    it("removeSession also removes from storage", async () => {
      const backendSession = await setupInitializedSession(bridge, adapter, "sess-1");

      expect(storage.load("sess-1")).not.toBeNull();

      bridge.removeSession("sess-1");
      expect(storage.load("sess-1")).toBeNull();
    });
  });

  // ── 8. Message history trimming ────────────────────────────────────────

  describe("Message history trimming (maxMessageHistoryLength)", () => {
    it("trims message history when exceeding maxMessageHistoryLength", async () => {
      const { bridge: trimBridge, adapter: trimAdapter } = createBridgeWithAdapter({
        config: { port: 3456, maxMessageHistoryLength: 3 },
      });
      await trimBridge.connectBackend("sess-1");

      // Send 5 user messages
      for (let i = 0; i < 5; i++) {
        trimBridge.sendUserMessage("sess-1", `Message ${i}`);
      }

      const snapshot = trimBridge.getSession("sess-1")!;
      expect(snapshot.messageHistoryLength).toBe(3);
    });

    it("keeps the most recent messages after trimming", async () => {
      const trimStorage = new MemoryStorage();
      const { bridge: trimBridge } = createBridgeWithAdapter({
        storage: trimStorage,
        config: { port: 3456, maxMessageHistoryLength: 2 },
      });
      await trimBridge.connectBackend("sess-1");

      trimBridge.sendUserMessage("sess-1", "First");
      trimBridge.sendUserMessage("sess-1", "Second");
      trimBridge.sendUserMessage("sess-1", "Third");

      // The persisted history should contain only the last 2 messages
      const persisted = trimStorage.load("sess-1")!;
      expect(persisted.messageHistory).toHaveLength(2);
      expect(persisted.messageHistory[0]).toEqual(
        expect.objectContaining({ type: "user_message", content: "Second" }),
      );
      expect(persisted.messageHistory[1]).toEqual(
        expect.objectContaining({ type: "user_message", content: "Third" }),
      );
    });

    it("assistant and result messages also count toward the limit", async () => {
      const { bridge: trimBridge, adapter: trimAdapter } = createBridgeWithAdapter({
        config: { port: 3456, maxMessageHistoryLength: 2 },
      });
      await trimBridge.connectBackend("sess-1");
      const trimBackendSession = trimAdapter.getSession("sess-1")!;

      // user message -> assistant -> result = 3 history entries, limit is 2
      trimBridge.sendUserMessage("sess-1", "hello");
      trimBackendSession.pushMessage(makeAssistantUnifiedMsg());
      await tick();
      trimBackendSession.pushMessage(makeResultUnifiedMsg());
      await tick();

      expect(trimBridge.getSession("sess-1")!.messageHistoryLength).toBe(2);
    });
  });

  // ── 10. Edge cases ─────────────────────────────────────────────────────

  describe("Edge cases", () => {
    it("queues messages when backend is not connected (I5)", async () => {
      bridge.getOrCreateSession("sess-1");
      // No backend connected

      bridge.sendUserMessage("sess-1", "Will be queued");
      bridge.sendInterrupt("sess-1");

      // Now connect backend
      await bridge.connectBackend("sess-1");
      const backendSession = adapter.getSession("sess-1")!;

      // The queued user message should have been flushed via send()
      const flushed = backendSession.sentMessages.some((m) => m.type === "user_message");
      expect(flushed).toBe(true);
    });

    it("unknown permission request_ids produce no backend message (S4)", async () => {
      await bridge.connectBackend("sess-1");
      const backendSession = adapter.getSession("sess-1")!;
      backendSession.sentMessages.length = 0;

      // No permission was requested, try to respond anyway
      bridge.sendPermissionResponse("sess-1", "unknown-request-id", "allow");

      expect(backendSession.sentMessages).toHaveLength(0);
    });

    it("permission response with updatedPermissions includes them", async () => {
      await bridge.connectBackend("sess-1");
      const backendSession = adapter.getSession("sess-1")!;

      backendSession.pushMessage(makePermissionRequestUnifiedMsg());
      await tick();
      backendSession.sentMessages.length = 0;

      bridge.sendPermissionResponse("sess-1", "perm-req-1", "allow", {
        updatedPermissions: [{ type: "setMode", mode: "plan", destination: "session" }],
      });

      // In the adapter path, updatedPermissions are included in the unified message
      const permMsg = backendSession.sentMessages.find((m) => m.type === "permission_response");
      expect(permMsg).toBeDefined();
      expect(permMsg!.metadata.updated_permissions).toEqual([
        { type: "setMode", mode: "plan", destination: "session" },
      ]);
    });

    it("empty sessions are retrievable with default state", () => {
      bridge.getOrCreateSession("empty-sess");
      const snapshot = bridge.getSession("empty-sess")!;

      expect(snapshot.state.model).toBe("");
      expect(snapshot.state.cwd).toBe("");
      expect(snapshot.state.tools).toEqual([]);
      expect(snapshot.state.total_cost_usd).toBe(0);
      expect(snapshot.state.num_turns).toBe(0);
      expect(snapshot.state.is_compacting).toBe(false);
      expect(snapshot.cliConnected).toBe(false);
      expect(snapshot.consumerCount).toBe(0);
      expect(snapshot.messageHistoryLength).toBe(0);
    });

    it("handleConsumerMessage handles Buffer input", async () => {
      await bridge.connectBackend("sess-1");
      const backendSession = adapter.getSession("sess-1")!;
      const ws = createMockSocket();
      bridge.handleConsumerOpen(ws, authContext("sess-1"));
      backendSession.sentMessages.length = 0;

      const bufferData = Buffer.from(JSON.stringify({ type: "interrupt" }));
      bridge.handleConsumerMessage(ws, "sess-1", bufferData);

      const interruptMsg = backendSession.sentMessages.find((m) => m.type === "interrupt");
      expect(interruptMsg).toBeDefined();
    });

    it("broadcastNameUpdate sends session_name_update to consumers", () => {
      bridge.getOrCreateSession("sess-1");
      const consumerSocket = createMockSocket();
      bridge.handleConsumerOpen(consumerSocket, authContext("sess-1"));
      consumerSocket.sentMessages.length = 0;

      bridge.broadcastNameUpdate("sess-1", "My Session");

      const parsed = consumerSocket.sentMessages.map((m) => JSON.parse(m));
      expect(parsed[0]).toEqual({ type: "session_name_update", name: "My Session" });
    });

    it("broadcastNameUpdate is a no-op for nonexistent sessions", () => {
      expect(() => bridge.broadcastNameUpdate("nonexistent", "name")).not.toThrow();
    });

    it("consumer socket that throws on send is removed from the set", async () => {
      await bridge.connectBackend("sess-1");
      const backendSession = adapter.getSession("sess-1")!;

      const failSocket = createMockSocket();
      failSocket.send = vi.fn(() => {
        throw new Error("Write failed");
      });
      bridge.handleConsumerOpen(failSocket, authContext("sess-1"));

      // Trigger a broadcast that will cause failSocket to throw
      backendSession.pushMessage(makeAssistantUnifiedMsg());
      await tick();

      // After the failed send, the consumer count should be reduced
      expect(bridge.getSession("sess-1")!.consumerCount).toBe(0);
    });

    it("multiple consumers all receive the same broadcast", async () => {
      await bridge.connectBackend("sess-1");
      const backendSession = adapter.getSession("sess-1")!;

      const consumer1 = createMockSocket();
      const consumer2 = createMockSocket();
      const consumer3 = createMockSocket();
      bridge.handleConsumerOpen(consumer1, authContext("sess-1"));
      bridge.handleConsumerOpen(consumer2, authContext("sess-1"));
      bridge.handleConsumerOpen(consumer3, authContext("sess-1"));

      consumer1.sentMessages.length = 0;
      consumer2.sentMessages.length = 0;
      consumer3.sentMessages.length = 0;

      backendSession.pushMessage(makeAssistantUnifiedMsg());
      await tick();

      for (const consumer of [consumer1, consumer2, consumer3]) {
        const parsed = consumer.sentMessages.map((m) => JSON.parse(m));
        expect(parsed.some((m: any) => m.type === "assistant")).toBe(true);
      }
    });

    it("closeSession handles consumer socket close error gracefully", async () => {
      bridge.getOrCreateSession("sess-1");
      const consumerSocket = createMockSocket();
      consumerSocket.close = vi.fn(() => {
        throw new Error("Already closed");
      });
      bridge.handleConsumerOpen(consumerSocket, authContext("sess-1"));

      await expect(bridge.closeSession("sess-1")).resolves.toBeUndefined();
      expect(bridge.getSession("sess-1")).toBeUndefined();
    });

    it("sendUserMessage with user_message via consumer includes session_id override", async () => {
      await bridge.connectBackend("sess-1");
      const backendSession = adapter.getSession("sess-1")!;

      // First populate the backend session_id via init
      backendSession.pushMessage(makeSessionInitMsg({ session_id: "cli-real-id" }));
      await tick();

      const ws = createMockSocket();
      bridge.handleConsumerOpen(ws, authContext("sess-1"));
      backendSession.sentMessages.length = 0;

      bridge.handleConsumerMessage(
        ws,
        "sess-1",
        JSON.stringify({ type: "user_message", content: "test", session_id: "cli-real-id" }),
      );

      const userMsg = backendSession.sentMessages.find((m) => m.type === "user_message");
      expect(userMsg).toBeDefined();
      expect(userMsg!.metadata.session_id).toBe("cli-real-id");
    });

    it("deny permission response is sent to backend", async () => {
      await bridge.connectBackend("sess-1");
      const backendSession = adapter.getSession("sess-1")!;

      backendSession.pushMessage(makePermissionRequestUnifiedMsg());
      await tick();
      backendSession.sentMessages.length = 0;

      bridge.sendPermissionResponse("sess-1", "perm-req-1", "deny");

      const permMsg = backendSession.sentMessages.find((m) => m.type === "permission_response");
      expect(permMsg).toBeDefined();
      expect(permMsg!.metadata.behavior).toBe("deny");
      expect(permMsg!.metadata.request_id).toBe("perm-req-1");
    });
  });

  // ── 13. Presence ────────────────────────────────────────────────────────

  describe("Presence", () => {
    it("presence_update broadcast on connect", () => {
      bridge.getOrCreateSession("sess-1");
      const ws1 = createMockSocket();
      bridge.handleConsumerOpen(ws1, authContext("sess-1"));

      const parsed = ws1.sentMessages.map((m) => JSON.parse(m));
      const presenceMsg = parsed.find((m: any) => m.type === "presence_update");
      expect(presenceMsg).toBeDefined();
      expect(presenceMsg.consumers).toHaveLength(1);
      expect(presenceMsg.consumers[0].userId).toBe("anonymous-1");
    });

    it("presence_update broadcast on disconnect", () => {
      bridge.getOrCreateSession("sess-1");
      const ws1 = createMockSocket();
      const ws2 = createMockSocket();
      bridge.handleConsumerOpen(ws1, authContext("sess-1"));
      bridge.handleConsumerOpen(ws2, authContext("sess-1"));

      ws1.sentMessages.length = 0;
      ws2.sentMessages.length = 0;

      bridge.handleConsumerClose(ws2, "sess-1");

      // ws1 should receive a presence_update with only 1 consumer
      const parsed = ws1.sentMessages.map((m) => JSON.parse(m));
      const presenceMsg = parsed.find((m: any) => m.type === "presence_update");
      expect(presenceMsg).toBeDefined();
      expect(presenceMsg.consumers).toHaveLength(1);
    });

    it("presence_update contains all connected consumers with roles", () => {
      bridge.getOrCreateSession("sess-1");
      const ws1 = createMockSocket();
      const ws2 = createMockSocket();
      bridge.handleConsumerOpen(ws1, authContext("sess-1"));
      bridge.handleConsumerOpen(ws2, authContext("sess-1"));

      // Check last presence_update sent to ws1 (triggered by ws2 connecting)
      const allMsgs = ws1.sentMessages.map((m) => JSON.parse(m));
      const presenceMsgs = allMsgs.filter((m: any) => m.type === "presence_update");
      const lastPresence = presenceMsgs[presenceMsgs.length - 1];
      expect(lastPresence.consumers).toHaveLength(2);
      expect(lastPresence.consumers[0]).toEqual(
        expect.objectContaining({ userId: "anonymous-1", role: "participant" }),
      );
      expect(lastPresence.consumers[1]).toEqual(
        expect.objectContaining({ userId: "anonymous-2", role: "participant" }),
      );
    });

    it("presence_query triggers presence broadcast", () => {
      bridge.getOrCreateSession("sess-1");
      const ws1 = createMockSocket();
      const ws2 = createMockSocket();
      bridge.handleConsumerOpen(ws1, authContext("sess-1"));
      bridge.handleConsumerOpen(ws2, authContext("sess-1"));
      ws1.sentMessages.length = 0;
      ws2.sentMessages.length = 0;

      bridge.handleConsumerMessage(ws1, "sess-1", JSON.stringify({ type: "presence_query" }));

      // Both consumers should get presence_update
      for (const ws of [ws1, ws2]) {
        const parsed = ws.sentMessages.map((m) => JSON.parse(m));
        expect(parsed.some((m: any) => m.type === "presence_update")).toBe(true);
      }
    });

    it("getSession includes consumers array", () => {
      bridge.getOrCreateSession("sess-1");
      const ws = createMockSocket();
      bridge.handleConsumerOpen(ws, authContext("sess-1"));

      const snapshot = bridge.getSession("sess-1")!;
      expect(snapshot.consumers).toHaveLength(1);
      expect(snapshot.consumers[0]).toEqual({
        userId: "anonymous-1",
        displayName: "User 1",
        role: "participant",
      });
    });
  });

  // ── backend:* events ────────────────────────────────────────────────────

  describe("backend:* events", () => {
    it("emits backend:connected on connectBackend", async () => {
      bridge.getOrCreateSession("sess-1");
      const backendHandler = vi.fn();
      bridge.on("backend:connected", backendHandler);

      await bridge.connectBackend("sess-1");

      expect(backendHandler).toHaveBeenCalledWith({ sessionId: "sess-1" });
    });

    it("emits backend:disconnected on disconnectBackend", async () => {
      await bridge.connectBackend("sess-1");

      const backendHandler = vi.fn();
      bridge.on("backend:disconnected", backendHandler);

      await bridge.disconnectBackend("sess-1");

      expect(backendHandler).toHaveBeenCalledWith({
        sessionId: "sess-1",
        code: 1000,
        reason: "normal",
      });
    });

    it("emits backend:session_id on system init", async () => {
      await bridge.connectBackend("sess-1");
      const backendSession = adapter.getSession("sess-1")!;

      const backendHandler = vi.fn();
      bridge.on("backend:session_id", backendHandler);

      backendSession.pushMessage(makeSessionInitMsg({ session_id: "cli-abc" }));
      await tick();

      expect(backendHandler).toHaveBeenCalledWith({
        sessionId: "sess-1",
        backendSessionId: "cli-abc",
      });
    });

    it("emits backend:relaunch_needed when consumer opens and backend is dead", () => {
      bridge.getOrCreateSession("sess-1");
      const backendHandler = vi.fn();
      bridge.on("backend:relaunch_needed", backendHandler);

      bridge.handleConsumerOpen(createMockSocket(), authContext("sess-1"));

      expect(backendHandler).toHaveBeenCalledWith({ sessionId: "sess-1" });
    });

    it("does not emit backend:relaunch_needed when backend is connected", async () => {
      await bridge.connectBackend("sess-1");

      const handler = vi.fn();
      bridge.on("backend:relaunch_needed", handler);

      bridge.handleConsumerOpen(createMockSocket(), authContext("sess-1"));
      expect(handler).not.toHaveBeenCalled();
    });
  });

  // ─── Error path coverage (Task 11) ─────────────────────────────────────

  describe("error paths", () => {
    it("handleConsumerMessage exceeding MAX_CONSUMER_MESSAGE_SIZE closes socket with 1009", async () => {
      await bridge.connectBackend("sess-1");
      const backendSession = adapter.getSession("sess-1")!;

      const ws = createMockSocket();
      bridge.handleConsumerOpen(ws, authContext("sess-1"));
      backendSession.pushMessage(makeSessionInitMsg());
      await tick();

      // 256KB + 1
      const oversized = "x".repeat(262_145);
      bridge.handleConsumerMessage(ws, "sess-1", oversized);

      expect(ws.close).toHaveBeenCalledWith(1009, "Message Too Big");
    });

    it("messages queue when backend is not connected and flush on connect", async () => {
      const ws = createMockSocket();
      bridge.handleConsumerOpen(ws, authContext("sess-1"));

      // Send a consumer message without backend being connected
      bridge.handleConsumerMessage(
        ws,
        "sess-1",
        JSON.stringify({ type: "user_message", content: "hello" }),
      );

      // Connect backend and check flush
      await bridge.connectBackend("sess-1");
      const backendSession = adapter.getSession("sess-1")!;

      backendSession.pushMessage(makeSessionInitMsg());
      await tick();

      // After backend connects, queued messages should have been flushed via send()
      const flushed = backendSession.sentMessages.some((m) => m.type === "user_message");
      expect(flushed).toBe(true);
    });

    it("consumer open with unknown session auto-creates the session", () => {
      const ws = createMockSocket();

      // No backend has connected to "new-session" yet
      bridge.handleConsumerOpen(ws, authContext("new-session"));

      // Session should be auto-created
      const snapshot = bridge.getSession("new-session");
      expect(snapshot).toBeDefined();
      expect(snapshot!.consumerCount).toBe(1);
    });

    it("consumer message for session with no backend does not crash", () => {
      const ws = createMockSocket();
      bridge.handleConsumerOpen(ws, authContext("no-cli"));

      // Try to send a message without any backend
      expect(() => {
        bridge.handleConsumerMessage(
          ws,
          "no-cli",
          JSON.stringify({ type: "user_message", content: "test" }),
        );
      }).not.toThrow();
    });
  });

  // ── seedSessionState ────────────────────────────────────────────────────

  describe("seedSessionState", () => {
    it("populates cwd and model on session state", () => {
      bridge.seedSessionState("seed-1", { cwd: "/home/user/project", model: "opus" });
      const snap = bridge.getSession("seed-1");
      expect(snap).toBeDefined();
      expect(snap!.state.cwd).toBe("/home/user/project");
      expect(snap!.state.model).toBe("opus");
    });

    it("resolves git info when gitResolver is provided", () => {
      const mockGitResolver = {
        resolve: vi.fn().mockReturnValue({
          branch: "feat/test",
          isWorktree: true,
          repoRoot: "/repo",
          ahead: 2,
          behind: 1,
        }),
      };
      const gitBridge = new SessionBridge({
        gitResolver: mockGitResolver,
        config: { port: 3456 },
        logger: noopLogger,
      });

      gitBridge.seedSessionState("seed-2", { cwd: "/repo", model: "sonnet" });

      const snap = gitBridge.getSession("seed-2");
      expect(snap!.state.git_branch).toBe("feat/test");
      expect(snap!.state.is_worktree).toBe(true);
      expect(snap!.state.repo_root).toBe("/repo");
      expect(snap!.state.git_ahead).toBe(2);
      expect(snap!.state.git_behind).toBe(1);
      expect(mockGitResolver.resolve).toHaveBeenCalledWith("/repo");
    });

    it("does not overwrite cwd or model when params are undefined", () => {
      bridge.seedSessionState("seed-3", { cwd: "/first", model: "opus" });
      bridge.seedSessionState("seed-3", {});

      const snap = bridge.getSession("seed-3");
      expect(snap!.state.cwd).toBe("/first");
      expect(snap!.state.model).toBe("opus");
    });

    it("is idempotent: second call does not re-resolve git info", () => {
      const mockGitResolver = {
        resolve: vi.fn().mockReturnValue({
          branch: "main",
          isWorktree: false,
          repoRoot: "/repo",
        }),
      };
      const gitBridge = new SessionBridge({
        gitResolver: mockGitResolver,
        config: { port: 3456 },
        logger: noopLogger,
      });

      gitBridge.seedSessionState("seed-4", { cwd: "/repo" });
      gitBridge.seedSessionState("seed-4", { cwd: "/repo" });

      // resolve called only once -- second call skips due to git_branch already set
      expect(mockGitResolver.resolve).toHaveBeenCalledTimes(1);
    });

    it("does not spawn subprocesses repeatedly for non-git directories", () => {
      const mockGitResolver = {
        resolve: vi.fn().mockReturnValue(null), // non-git dir
      };
      const gitBridge = new SessionBridge({
        gitResolver: mockGitResolver,
        config: { port: 3456 },
        logger: noopLogger,
      });

      gitBridge.seedSessionState("seed-5", { cwd: "/tmp" });
      // Simulate consumer connecting
      const ws = createMockSocket();
      gitBridge.handleConsumerOpen(ws, authContext("seed-5"));

      // resolve called only once -- second call skipped due to attempt tracking
      expect(mockGitResolver.resolve).toHaveBeenCalledTimes(1);
    });

    it("does not crash when gitResolver.resolve() throws", () => {
      const mockGitResolver = {
        resolve: vi.fn().mockImplementation(() => {
          throw new Error("git not found");
        }),
      };
      const gitBridge = new SessionBridge({
        gitResolver: mockGitResolver,
        config: { port: 3456 },
        logger: noopLogger,
      });

      expect(() => {
        gitBridge.seedSessionState("seed-6", { cwd: "/repo" });
      }).not.toThrow();

      const snap = gitBridge.getSession("seed-6");
      expect(snap!.state.cwd).toBe("/repo");
      expect(snap!.state.git_branch).toBe("");
    });

    it("consumer connecting before backend receives seeded state in session_init", () => {
      const mockGitResolver = {
        resolve: vi.fn().mockReturnValue({
          branch: "develop",
          isWorktree: false,
          repoRoot: "/project",
          ahead: 0,
          behind: 0,
        }),
      };
      const gitBridge = new SessionBridge({
        gitResolver: mockGitResolver,
        config: { port: 3456 },
        logger: noopLogger,
      });

      // Seed state (simulating launcher.launch + seedSessionState)
      gitBridge.seedSessionState("seed-7", { cwd: "/project", model: "opus" });

      // Consumer connects before backend
      const ws = createMockSocket();
      gitBridge.handleConsumerOpen(ws, authContext("seed-7"));

      // Consumer should receive session_init with seeded state
      const parsed = ws.sentMessages.map((m: string) => JSON.parse(m));
      const initMsg = parsed.find((m: any) => m.type === "session_init");
      expect(initMsg).toBeDefined();
      expect(initMsg.session.cwd).toBe("/project");
      expect(initMsg.session.model).toBe("opus");
      expect(initMsg.session.git_branch).toBe("develop");
    });
  });
});
