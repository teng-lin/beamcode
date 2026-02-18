import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:crypto", () => ({ randomUUID: () => "test-uuid" }));

import { MemoryStorage } from "../adapters/memory-storage.js";
import type { Authenticator } from "../interfaces/auth.js";
import {
  authContext,
  createTestSocket as createMockSocket,
  makeAssistantMsg,
  makeAuthStatusMsg,
  makeControlRequestMsg,
  makeInitMsg,
  makeKeepAliveMsg,
  makeResultMsg,
  makeStatusMsg,
  makeStreamEventMsg,
  makeToolProgressMsg,
  makeToolUseSummaryMsg,
  noopLogger,
} from "../testing/cli-message-factories.js";
import { SessionBridge } from "./session-bridge.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createBridge(options?: {
  storage?: MemoryStorage;
  maxMessageHistoryLength?: number;
  authenticator?: Authenticator;
}) {
  const storage = options?.storage ?? new MemoryStorage();
  return {
    bridge: new SessionBridge({
      storage,
      authenticator: options?.authenticator,
      config: {
        port: 3456,
        ...(options?.maxMessageHistoryLength !== undefined
          ? { maxMessageHistoryLength: options.maxMessageHistoryLength }
          : {}),
      },
      logger: noopLogger,
    }),
    storage,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("SessionBridge", () => {
  let bridge: SessionBridge;
  let storage: MemoryStorage;

  beforeEach(() => {
    const created = createBridge();
    bridge = created.bridge;
    storage = created.storage;
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

    it("removeSession deletes a session from the bridge and storage", () => {
      bridge.getOrCreateSession("sess-1");
      // Trigger persistence so storage has it
      const cliSocket = createMockSocket();
      bridge.handleCLIOpen(cliSocket, "sess-1");
      bridge.handleCLIMessage("sess-1", makeInitMsg());

      bridge.removeSession("sess-1");
      expect(bridge.getSession("sess-1")).toBeUndefined();
      expect(storage.load("sess-1")).toBeNull();
    });

    it("closeSession closes CLI and consumer sockets, removes session, and emits event", () => {
      bridge.getOrCreateSession("sess-1");
      const cliSocket = createMockSocket();
      const consumerSocket = createMockSocket();

      bridge.handleCLIOpen(cliSocket, "sess-1");
      bridge.handleConsumerOpen(consumerSocket, authContext("sess-1"));

      const closedHandler = vi.fn();
      bridge.on("session:closed", closedHandler);

      bridge.closeSession("sess-1");

      expect(cliSocket.close).toHaveBeenCalled();
      expect(consumerSocket.close).toHaveBeenCalled();
      expect(bridge.getSession("sess-1")).toBeUndefined();
      expect(closedHandler).toHaveBeenCalledWith({ sessionId: "sess-1" });
    });

    it("closeSession is a no-op for nonexistent sessions", () => {
      expect(() => bridge.closeSession("nonexistent")).not.toThrow();
    });

    it("close shuts down all sessions and removes all listeners", () => {
      bridge.getOrCreateSession("sess-1");
      bridge.getOrCreateSession("sess-2");
      const cli1 = createMockSocket();
      const cli2 = createMockSocket();
      bridge.handleCLIOpen(cli1, "sess-1");
      bridge.handleCLIOpen(cli2, "sess-2");

      bridge.close();

      expect(bridge.getAllSessions()).toHaveLength(0);
      expect(cli1.close).toHaveBeenCalled();
      expect(cli2.close).toHaveBeenCalled();
    });

    it("isCliConnected returns false when no CLI connected", () => {
      bridge.getOrCreateSession("sess-1");
      expect(bridge.isCliConnected("sess-1")).toBe(false);
    });

    it("isCliConnected returns true when CLI is connected", () => {
      bridge.getOrCreateSession("sess-1");
      const cliSocket = createMockSocket();
      bridge.handleCLIOpen(cliSocket, "sess-1");
      expect(bridge.isCliConnected("sess-1")).toBe(true);
    });
  });

  // ── 2. CLI WebSocket handlers ──────────────────────────────────────────

  describe("CLI WebSocket handlers", () => {
    it("handleCLIOpen sets CLI socket and emits cli:connected", () => {
      bridge.getOrCreateSession("sess-1");
      const handler = vi.fn();
      bridge.on("cli:connected", handler);

      const cliSocket = createMockSocket();
      bridge.handleCLIOpen(cliSocket, "sess-1");

      expect(bridge.isCliConnected("sess-1")).toBe(true);
      expect(handler).toHaveBeenCalledWith({ sessionId: "sess-1" });
    });

    it("handleCLIOpen broadcasts cli_connected to consumers", () => {
      bridge.getOrCreateSession("sess-1");
      const consumerSocket = createMockSocket();
      bridge.handleConsumerOpen(consumerSocket, authContext("sess-1"));

      // Clear messages sent during consumer open
      consumerSocket.sentMessages.length = 0;

      const cliSocket = createMockSocket();
      bridge.handleCLIOpen(cliSocket, "sess-1");

      const parsed = consumerSocket.sentMessages.map((m) => JSON.parse(m));
      expect(parsed.some((m: any) => m.type === "cli_connected")).toBe(true);
    });

    it("handleCLIOpen flushes queued pending messages", () => {
      bridge.getOrCreateSession("sess-1");

      // Queue a message while CLI is not connected
      bridge.sendUserMessage("sess-1", "Hello");
      const _snapshot = bridge.getSession("sess-1")!;
      // The message should be queued (not sent to CLI since CLI is not connected)

      const cliSocket = createMockSocket();
      bridge.handleCLIOpen(cliSocket, "sess-1");

      // The queued user message should have been flushed to the CLI
      expect(cliSocket.sentMessages.length).toBeGreaterThanOrEqual(1);
      const sentToCliParsed = cliSocket.sentMessages.map((m) => JSON.parse(m.trim()));
      expect(sentToCliParsed.some((m: any) => m.type === "user")).toBe(true);
    });

    it("handleCLIMessage routes NDJSON messages correctly", () => {
      bridge.getOrCreateSession("sess-1");
      const cliSocket = createMockSocket();
      bridge.handleCLIOpen(cliSocket, "sess-1");

      const consumerSocket = createMockSocket();
      bridge.handleConsumerOpen(consumerSocket, authContext("sess-1"));
      consumerSocket.sentMessages.length = 0;

      bridge.handleCLIMessage("sess-1", makeInitMsg());

      const parsed = consumerSocket.sentMessages.map((m) => JSON.parse(m));
      expect(parsed.some((m: any) => m.type === "session_init")).toBe(true);
    });

    it("handleCLIMessage handles multiple NDJSON lines in one frame", () => {
      bridge.getOrCreateSession("sess-1");
      const cliSocket = createMockSocket();
      bridge.handleCLIOpen(cliSocket, "sess-1");

      const consumerSocket = createMockSocket();
      bridge.handleConsumerOpen(consumerSocket, authContext("sess-1"));
      consumerSocket.sentMessages.length = 0;

      const multiLine = `${makeInitMsg()}\n${makeAssistantMsg()}`;
      bridge.handleCLIMessage("sess-1", multiLine);

      const parsed = consumerSocket.sentMessages.map((m) => JSON.parse(m));
      expect(parsed.some((m: any) => m.type === "session_init")).toBe(true);
      expect(parsed.some((m: any) => m.type === "assistant")).toBe(true);
    });

    it("handleCLIMessage ignores messages for nonexistent sessions", () => {
      expect(() => bridge.handleCLIMessage("no-such-session", makeInitMsg())).not.toThrow();
    });

    it("handleCLIClose clears CLI socket, emits event, and cancels pending permissions", () => {
      bridge.getOrCreateSession("sess-1");
      const cliSocket = createMockSocket();
      bridge.handleCLIOpen(cliSocket, "sess-1");

      // Add a pending permission
      bridge.handleCLIMessage("sess-1", makeControlRequestMsg());

      const consumerSocket = createMockSocket();
      bridge.handleConsumerOpen(consumerSocket, authContext("sess-1"));
      consumerSocket.sentMessages.length = 0;

      const handler = vi.fn();
      bridge.on("cli:disconnected", handler);

      bridge.handleCLIClose("sess-1");

      expect(bridge.isCliConnected("sess-1")).toBe(false);
      expect(handler).toHaveBeenCalledWith({ sessionId: "sess-1" });

      const parsed = consumerSocket.sentMessages.map((m) => JSON.parse(m));
      expect(parsed.some((m: any) => m.type === "cli_disconnected")).toBe(true);
      expect(parsed.some((m: any) => m.type === "permission_cancelled")).toBe(true);
    });

    it("handleCLIClose is safe on nonexistent sessions", () => {
      expect(() => bridge.handleCLIClose("nonexistent")).not.toThrow();
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

    it("handleConsumerOpen replays message history", () => {
      bridge.getOrCreateSession("sess-1");
      const cliSocket = createMockSocket();
      bridge.handleCLIOpen(cliSocket, "sess-1");

      // Build up some message history
      bridge.handleCLIMessage("sess-1", makeAssistantMsg());

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

    it("handleConsumerOpen sends pending permission requests", () => {
      bridge.getOrCreateSession("sess-1");
      const cliSocket = createMockSocket();
      bridge.handleCLIOpen(cliSocket, "sess-1");
      bridge.handleCLIMessage("sess-1", makeControlRequestMsg());

      const consumerSocket = createMockSocket();
      bridge.handleConsumerOpen(consumerSocket, authContext("sess-1"));

      const parsed = consumerSocket.sentMessages.map((m) => JSON.parse(m));
      expect(parsed.some((m: any) => m.type === "permission_request")).toBe(true);
    });

    it("handleConsumerOpen sends cli_disconnected and emits relaunch_needed when CLI is not connected", () => {
      bridge.getOrCreateSession("sess-1");
      const relaunchHandler = vi.fn();
      bridge.on("cli:relaunch_needed", relaunchHandler);

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

    it("handleConsumerMessage routes user_message to CLI", () => {
      bridge.getOrCreateSession("sess-1");
      const cliSocket = createMockSocket();
      bridge.handleCLIOpen(cliSocket, "sess-1");
      cliSocket.sentMessages.length = 0;

      const consumerSocket = createMockSocket();
      bridge.handleConsumerOpen(consumerSocket, authContext("sess-1"));

      bridge.handleConsumerMessage(
        consumerSocket,
        "sess-1",
        JSON.stringify({ type: "user_message", content: "Hello from consumer" }),
      );

      const sentToCli = cliSocket.sentMessages.map((m) => JSON.parse(m.trim()));
      expect(
        sentToCli.some(
          (m: any) => m.type === "user" && m.message.content === "Hello from consumer",
        ),
      ).toBe(true);
    });

    it("handleConsumerMessage emits message:inbound event", () => {
      bridge.getOrCreateSession("sess-1");
      const cliSocket = createMockSocket();
      bridge.handleCLIOpen(cliSocket, "sess-1");

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

  // ── 4. Programmatic API ────────────────────────────────────────────────

  describe("Programmatic API", () => {
    it("sendUserMessage sends NDJSON user message to CLI", () => {
      bridge.getOrCreateSession("sess-1");
      const cliSocket = createMockSocket();
      bridge.handleCLIOpen(cliSocket, "sess-1");
      cliSocket.sentMessages.length = 0;

      bridge.sendUserMessage("sess-1", "Hello world");

      expect(cliSocket.sentMessages).toHaveLength(1);
      const parsed = JSON.parse(cliSocket.sentMessages[0].trim());
      expect(parsed.type).toBe("user");
      expect(parsed.message.role).toBe("user");
      expect(parsed.message.content).toBe("Hello world");
    });

    it("sendUserMessage with images sends content block array", () => {
      bridge.getOrCreateSession("sess-1");
      const cliSocket = createMockSocket();
      bridge.handleCLIOpen(cliSocket, "sess-1");
      cliSocket.sentMessages.length = 0;

      bridge.sendUserMessage("sess-1", "Describe this", {
        images: [{ media_type: "image/png", data: "base64data" }],
      });

      const parsed = JSON.parse(cliSocket.sentMessages[0].trim());
      expect(Array.isArray(parsed.message.content)).toBe(true);
      expect(parsed.message.content).toHaveLength(2);
      expect(parsed.message.content[0].type).toBe("image");
      expect(parsed.message.content[1].type).toBe("text");
      expect(parsed.message.content[1].text).toBe("Describe this");
    });

    it("sendUserMessage adds message to history", () => {
      bridge.getOrCreateSession("sess-1");
      const cliSocket = createMockSocket();
      bridge.handleCLIOpen(cliSocket, "sess-1");

      bridge.sendUserMessage("sess-1", "Hello");

      const snapshot = bridge.getSession("sess-1")!;
      expect(snapshot.messageHistoryLength).toBe(1);
    });

    it("sendUserMessage with sessionIdOverride uses that session_id in the message", () => {
      bridge.getOrCreateSession("sess-1");
      const cliSocket = createMockSocket();
      bridge.handleCLIOpen(cliSocket, "sess-1");
      cliSocket.sentMessages.length = 0;

      bridge.sendUserMessage("sess-1", "Hello", { sessionIdOverride: "override-id" });

      const parsed = JSON.parse(cliSocket.sentMessages[0].trim());
      expect(parsed.session_id).toBe("override-id");
    });

    it("sendUserMessage is a no-op for nonexistent sessions", () => {
      expect(() => bridge.sendUserMessage("nonexistent", "hello")).not.toThrow();
    });

    it("sendPermissionResponse allows a pending permission", () => {
      bridge.getOrCreateSession("sess-1");
      const cliSocket = createMockSocket();
      bridge.handleCLIOpen(cliSocket, "sess-1");

      bridge.handleCLIMessage("sess-1", makeControlRequestMsg());
      cliSocket.sentMessages.length = 0;

      const resolvedHandler = vi.fn();
      bridge.on("permission:resolved", resolvedHandler);

      bridge.sendPermissionResponse("sess-1", "perm-req-1", "allow");

      expect(cliSocket.sentMessages).toHaveLength(1);
      const parsed = JSON.parse(cliSocket.sentMessages[0].trim());
      expect(parsed.type).toBe("control_response");
      expect(parsed.response.response.behavior).toBe("allow");
      expect(resolvedHandler).toHaveBeenCalledWith({
        sessionId: "sess-1",
        requestId: "perm-req-1",
        behavior: "allow",
      });
    });

    it("sendPermissionResponse denies a pending permission", () => {
      bridge.getOrCreateSession("sess-1");
      const cliSocket = createMockSocket();
      bridge.handleCLIOpen(cliSocket, "sess-1");

      bridge.handleCLIMessage("sess-1", makeControlRequestMsg());
      cliSocket.sentMessages.length = 0;

      bridge.sendPermissionResponse("sess-1", "perm-req-1", "deny", { message: "No thanks" });

      const parsed = JSON.parse(cliSocket.sentMessages[0].trim());
      expect(parsed.response.response.behavior).toBe("deny");
      expect(parsed.response.response.message).toBe("No thanks");
    });

    it("sendPermissionResponse with unknown request_id is a no-op (S4)", () => {
      bridge.getOrCreateSession("sess-1");
      const cliSocket = createMockSocket();
      bridge.handleCLIOpen(cliSocket, "sess-1");
      cliSocket.sentMessages.length = 0;

      bridge.sendPermissionResponse("sess-1", "unknown-req", "allow");

      expect(cliSocket.sentMessages).toHaveLength(0);
    });

    it("sendPermissionResponse is a no-op for nonexistent sessions", () => {
      expect(() => bridge.sendPermissionResponse("nonexistent", "req-1", "allow")).not.toThrow();
    });

    it("sendInterrupt sends interrupt control request to CLI", () => {
      bridge.getOrCreateSession("sess-1");
      const cliSocket = createMockSocket();
      bridge.handleCLIOpen(cliSocket, "sess-1");
      cliSocket.sentMessages.length = 0;

      bridge.sendInterrupt("sess-1");

      const parsed = JSON.parse(cliSocket.sentMessages[0].trim());
      expect(parsed.type).toBe("control_request");
      expect(parsed.request.subtype).toBe("interrupt");
      expect(parsed.request_id).toBe("test-uuid");
    });

    it("sendInterrupt is a no-op for nonexistent sessions", () => {
      expect(() => bridge.sendInterrupt("nonexistent")).not.toThrow();
    });

    it("sendSetModel sends set_model control request to CLI", () => {
      bridge.getOrCreateSession("sess-1");
      const cliSocket = createMockSocket();
      bridge.handleCLIOpen(cliSocket, "sess-1");
      cliSocket.sentMessages.length = 0;

      bridge.sendSetModel("sess-1", "claude-opus-4-20250514");

      const parsed = JSON.parse(cliSocket.sentMessages[0].trim());
      expect(parsed.type).toBe("control_request");
      expect(parsed.request.subtype).toBe("set_model");
      expect(parsed.request.model).toBe("claude-opus-4-20250514");
    });

    it("sendSetModel is a no-op for nonexistent sessions", () => {
      expect(() => bridge.sendSetModel("nonexistent", "model")).not.toThrow();
    });

    it("sendSetPermissionMode sends set_permission_mode to CLI", () => {
      bridge.getOrCreateSession("sess-1");
      const cliSocket = createMockSocket();
      bridge.handleCLIOpen(cliSocket, "sess-1");
      cliSocket.sentMessages.length = 0;

      bridge.sendSetPermissionMode("sess-1", "plan");

      const parsed = JSON.parse(cliSocket.sentMessages[0].trim());
      expect(parsed.type).toBe("control_request");
      expect(parsed.request.subtype).toBe("set_permission_mode");
      expect(parsed.request.mode).toBe("plan");
    });

    it("sendSetPermissionMode is a no-op for nonexistent sessions", () => {
      expect(() => bridge.sendSetPermissionMode("nonexistent", "plan")).not.toThrow();
    });
  });

  // ── 5. CLI message routing ─────────────────────────────────────────────

  describe("CLI message routing", () => {
    let cliSocket: ReturnType<typeof createMockSocket>;
    let consumerSocket: ReturnType<typeof createMockSocket>;

    beforeEach(() => {
      bridge.getOrCreateSession("sess-1");
      cliSocket = createMockSocket();
      bridge.handleCLIOpen(cliSocket, "sess-1");
      consumerSocket = createMockSocket();
      bridge.handleConsumerOpen(consumerSocket, authContext("sess-1"));
      consumerSocket.sentMessages.length = 0;
    });

    it("system init updates session state and emits cli:session_id", () => {
      const handler = vi.fn();
      bridge.on("cli:session_id", handler);

      bridge.handleCLIMessage("sess-1", makeInitMsg({ session_id: "cli-abc" }));

      expect(handler).toHaveBeenCalledWith({
        sessionId: "sess-1",
        cliSessionId: "cli-abc",
      });

      const state = bridge.getSession("sess-1")!.state;
      expect(state.model).toBe("claude-sonnet-4-5-20250929");
      expect(state.cwd).toBe("/test");
      expect(state.tools).toEqual(["Bash", "Read"]);
      expect(state.permissionMode).toBe("default");
      expect(state.claude_code_version).toBe("1.0");
    });

    it("system init broadcasts session_init to consumers", () => {
      bridge.handleCLIMessage("sess-1", makeInitMsg());

      const parsed = consumerSocket.sentMessages.map((m) => JSON.parse(m));
      const initMsg = parsed.find((m: any) => m.type === "session_init");
      expect(initMsg).toBeDefined();
      expect(initMsg.session.model).toBe("claude-sonnet-4-5-20250929");
    });

    it("system status updates is_compacting and broadcasts status_change", () => {
      bridge.handleCLIMessage("sess-1", makeStatusMsg({ status: "compacting" }));

      const state = bridge.getSession("sess-1")!.state;
      expect(state.is_compacting).toBe(true);

      const parsed = consumerSocket.sentMessages.map((m) => JSON.parse(m));
      expect(parsed.some((m: any) => m.type === "status_change" && m.status === "compacting")).toBe(
        true,
      );
    });

    it("system status with null status clears is_compacting", () => {
      // First set compacting
      bridge.handleCLIMessage("sess-1", makeStatusMsg({ status: "compacting" }));
      expect(bridge.getSession("sess-1")!.state.is_compacting).toBe(true);

      // Then clear it
      bridge.handleCLIMessage("sess-1", makeStatusMsg({ status: null }));
      expect(bridge.getSession("sess-1")!.state.is_compacting).toBe(false);
    });

    it("system status with permissionMode updates session state", () => {
      bridge.handleCLIMessage("sess-1", makeStatusMsg({ permissionMode: "plan" }));
      expect(bridge.getSession("sess-1")!.state.permissionMode).toBe("plan");
    });

    it("system status with permissionMode broadcasts session_update to consumers", () => {
      bridge.handleCLIMessage("sess-1", makeStatusMsg({ permissionMode: "plan" }));

      const parsed = consumerSocket.sentMessages.map((m) => JSON.parse(m));
      const updateMsg = parsed.find(
        (m: any) => m.type === "session_update" && m.session?.permissionMode,
      );
      expect(updateMsg).toBeDefined();
      expect(updateMsg.session.permissionMode).toBe("plan");
    });

    it("system status without permissionMode does not broadcast session_update", () => {
      bridge.handleCLIMessage("sess-1", makeStatusMsg({ status: "idle" }));

      const parsed = consumerSocket.sentMessages.map((m) => JSON.parse(m));
      const updateMsg = parsed.find((m: any) => m.type === "session_update");
      expect(updateMsg).toBeUndefined();
    });

    it("assistant message is stored in history and broadcast", () => {
      bridge.handleCLIMessage("sess-1", makeAssistantMsg());

      const snapshot = bridge.getSession("sess-1")!;
      expect(snapshot.messageHistoryLength).toBe(1);

      const parsed = consumerSocket.sentMessages.map((m) => JSON.parse(m));
      const assistantMsg = parsed.find((m: any) => m.type === "assistant");
      expect(assistantMsg).toBeDefined();
      expect(assistantMsg.message.content[0].text).toBe("Hello world");
      expect(assistantMsg.parent_tool_use_id).toBeNull();
    });

    it("result message updates session cost/turns and broadcasts", () => {
      bridge.handleCLIMessage(
        "sess-1",
        makeResultMsg({
          total_cost_usd: 0.05,
          num_turns: 3,
          total_lines_added: 10,
          total_lines_removed: 5,
        }),
      );

      const state = bridge.getSession("sess-1")!.state;
      expect(state.total_cost_usd).toBe(0.05);
      expect(state.num_turns).toBe(3);
      expect(state.total_lines_added).toBe(10);
      expect(state.total_lines_removed).toBe(5);

      const parsed = consumerSocket.sentMessages.map((m) => JSON.parse(m));
      expect(parsed.some((m: any) => m.type === "result")).toBe(true);
    });

    it("result message computes context_used_percent from modelUsage", () => {
      bridge.handleCLIMessage(
        "sess-1",
        makeResultMsg({
          modelUsage: {
            "claude-sonnet-4-5-20250929": {
              inputTokens: 5000,
              outputTokens: 5000,
              cacheReadInputTokens: 0,
              cacheCreationInputTokens: 0,
              contextWindow: 200000,
              maxOutputTokens: 8192,
              costUSD: 0.01,
            },
          },
        }),
      );

      const state = bridge.getSession("sess-1")!.state;
      expect(state.context_used_percent).toBe(5); // (5000+5000)/200000*100 = 5
    });

    it("result with num_turns=1 and user message emits session:first_turn_completed", () => {
      // First add a user message to history
      bridge.sendUserMessage("sess-1", "What is TypeScript?");

      const handler = vi.fn();
      bridge.on("session:first_turn_completed", handler);

      bridge.handleCLIMessage("sess-1", makeResultMsg({ num_turns: 1, is_error: false }));

      expect(handler).toHaveBeenCalledWith({
        sessionId: "sess-1",
        firstUserMessage: "What is TypeScript?",
      });
    });

    it("result with is_error=true does not emit session:first_turn_completed", () => {
      bridge.sendUserMessage("sess-1", "test");

      const handler = vi.fn();
      bridge.on("session:first_turn_completed", handler);

      bridge.handleCLIMessage("sess-1", makeResultMsg({ num_turns: 1, is_error: true }));

      expect(handler).not.toHaveBeenCalled();
    });

    it("result message refreshes git info and broadcasts session_update if changed", () => {
      // Create a bridge with a mock gitResolver
      const mockGitResolver = {
        resolve: vi.fn().mockReturnValue({
          branch: "main",
          isWorktree: false,
          repoRoot: "/repo",
          ahead: 0,
          behind: 0,
        }),
      };
      const gitBridge = new SessionBridge({
        gitResolver: mockGitResolver,
        config: { port: 3456 },
        logger: noopLogger,
      });

      gitBridge.getOrCreateSession("sess-1");
      const gitCliSocket = createMockSocket();
      gitBridge.handleCLIOpen(gitCliSocket, "sess-1");
      const gitConsumerSocket = createMockSocket();
      gitBridge.handleConsumerOpen(gitConsumerSocket, authContext("sess-1"));

      // Trigger session_init so git info is initially resolved
      gitBridge.handleCLIMessage("sess-1", makeInitMsg());
      gitConsumerSocket.sentMessages.length = 0;

      // Update the mock to return different git_ahead
      mockGitResolver.resolve.mockReturnValue({
        branch: "main",
        isWorktree: false,
        repoRoot: "/repo",
        ahead: 3,
        behind: 0,
      });

      // Send a result message — should trigger refreshGitInfo
      gitBridge.handleCLIMessage("sess-1", makeResultMsg());

      // Should have broadcast a session_update with updated git_ahead
      const parsed = gitConsumerSocket.sentMessages.map((m: string) => JSON.parse(m));
      const updateMsg = parsed.find(
        (m: any) => m.type === "session_update" && m.session?.git_ahead !== undefined,
      );
      expect(updateMsg).toBeDefined();
      expect(updateMsg.session.git_ahead).toBe(3);
      expect(updateMsg.session.git_branch).toBe("main");

      // Session state should also be updated
      const state = gitBridge.getSession("sess-1")!.state;
      expect(state.git_ahead).toBe(3);
    });

    it("result message does not broadcast session_update when git info unchanged", () => {
      const mockGitResolver = {
        resolve: vi.fn().mockReturnValue({
          branch: "main",
          isWorktree: false,
          repoRoot: "/repo",
          ahead: 0,
          behind: 0,
        }),
      };
      const gitBridge = new SessionBridge({
        gitResolver: mockGitResolver,
        config: { port: 3456 },
        logger: noopLogger,
      });

      gitBridge.getOrCreateSession("sess-1");
      const gitCliSocket = createMockSocket();
      gitBridge.handleCLIOpen(gitCliSocket, "sess-1");
      const gitConsumerSocket = createMockSocket();
      gitBridge.handleConsumerOpen(gitConsumerSocket, authContext("sess-1"));

      // Trigger session_init so git info is initially resolved
      gitBridge.handleCLIMessage("sess-1", makeInitMsg());
      gitConsumerSocket.sentMessages.length = 0;

      // Git resolver returns same values — no change
      gitBridge.handleCLIMessage("sess-1", makeResultMsg());

      // Should NOT have broadcast a session_update with git fields
      const parsed = gitConsumerSocket.sentMessages.map((m: string) => JSON.parse(m));
      const updateMsg = parsed.find(
        (m: any) => m.type === "session_update" && m.session?.git_ahead !== undefined,
      );
      expect(updateMsg).toBeUndefined();
    });

    it("stream_event is broadcast to consumers", () => {
      bridge.handleCLIMessage("sess-1", makeStreamEventMsg());

      const parsed = consumerSocket.sentMessages.map((m) => JSON.parse(m));
      const streamMsg = parsed.find((m: any) => m.type === "stream_event");
      expect(streamMsg).toBeDefined();
      expect(streamMsg.parent_tool_use_id).toBeNull();
    });

    it("control_request (can_use_tool) stores permission and broadcasts", () => {
      const permHandler = vi.fn();
      bridge.on("permission:requested", permHandler);

      bridge.handleCLIMessage("sess-1", makeControlRequestMsg());

      const snapshot = bridge.getSession("sess-1")!;
      expect(snapshot.pendingPermissions).toHaveLength(1);
      expect(snapshot.pendingPermissions[0].tool_name).toBe("Bash");

      const parsed = consumerSocket.sentMessages.map((m) => JSON.parse(m));
      expect(parsed.some((m: any) => m.type === "permission_request")).toBe(true);

      expect(permHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: "sess-1",
          request: expect.objectContaining({ tool_name: "Bash" }),
        }),
      );
    });

    it("tool_progress is broadcast to consumers", () => {
      bridge.handleCLIMessage("sess-1", makeToolProgressMsg());

      const parsed = consumerSocket.sentMessages.map((m) => JSON.parse(m));
      const progressMsg = parsed.find((m: any) => m.type === "tool_progress");
      expect(progressMsg).toBeDefined();
      expect(progressMsg.tool_use_id).toBe("tu-1");
      expect(progressMsg.tool_name).toBe("Bash");
      expect(progressMsg.elapsed_time_seconds).toBe(5);
    });

    it("tool_use_summary is broadcast to consumers", () => {
      bridge.handleCLIMessage("sess-1", makeToolUseSummaryMsg());

      const parsed = consumerSocket.sentMessages.map((m) => JSON.parse(m));
      const summaryMsg = parsed.find((m: any) => m.type === "tool_use_summary");
      expect(summaryMsg).toBeDefined();
      expect(summaryMsg.summary).toBe("Ran bash command");
      expect(summaryMsg.tool_use_ids).toEqual(["tu-1", "tu-2"]);
    });

    it("auth_status is broadcast to consumers and emitted as event", () => {
      const handler = vi.fn();
      bridge.on("auth_status", handler);

      bridge.handleCLIMessage("sess-1", makeAuthStatusMsg());

      const parsed = consumerSocket.sentMessages.map((m) => JSON.parse(m));
      const authMsg = parsed.find((m: any) => m.type === "auth_status");
      expect(authMsg).toBeDefined();
      expect(authMsg.isAuthenticating).toBe(true);
      expect(authMsg.output).toEqual(["Authenticating..."]);

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: "sess-1",
          isAuthenticating: true,
          output: ["Authenticating..."],
        }),
      );
    });

    it("keep_alive is silently consumed (no broadcast)", () => {
      bridge.handleCLIMessage("sess-1", makeKeepAliveMsg());

      // Only message:outbound events from the broadcastToConsumers function.
      // keep_alive should NOT produce any consumer messages.
      expect(consumerSocket.sentMessages).toHaveLength(0);
    });
  });

  // ── 6. Consumer message routing ────────────────────────────────────────

  describe("Consumer message routing", () => {
    let cliSocket: ReturnType<typeof createMockSocket>;
    let consumerWs: ReturnType<typeof createMockSocket>;

    beforeEach(() => {
      bridge.getOrCreateSession("sess-1");
      cliSocket = createMockSocket();
      bridge.handleCLIOpen(cliSocket, "sess-1");
      consumerWs = createMockSocket();
      bridge.handleConsumerOpen(consumerWs, authContext("sess-1"));
      cliSocket.sentMessages.length = 0;
    });

    it("user_message routes through sendUserMessage to CLI", () => {
      bridge.handleConsumerMessage(
        consumerWs,
        "sess-1",
        JSON.stringify({ type: "user_message", content: "Hello!" }),
      );

      const parsed = cliSocket.sentMessages.map((m) => JSON.parse(m.trim()));
      expect(parsed.some((m: any) => m.type === "user" && m.message.content === "Hello!")).toBe(
        true,
      );
    });

    it("permission_response routes through sendPermissionResponse", () => {
      bridge.handleCLIMessage("sess-1", makeControlRequestMsg());
      cliSocket.sentMessages.length = 0;

      bridge.handleConsumerMessage(
        consumerWs,
        "sess-1",
        JSON.stringify({
          type: "permission_response",
          request_id: "perm-req-1",
          behavior: "allow",
        }),
      );

      const parsed = cliSocket.sentMessages.map((m) => JSON.parse(m.trim()));
      expect(parsed.some((m: any) => m.type === "control_response")).toBe(true);
    });

    it("interrupt routes through sendInterrupt", () => {
      bridge.handleConsumerMessage(consumerWs, "sess-1", JSON.stringify({ type: "interrupt" }));

      const parsed = cliSocket.sentMessages.map((m) => JSON.parse(m.trim()));
      expect(
        parsed.some((m: any) => m.type === "control_request" && m.request.subtype === "interrupt"),
      ).toBe(true);
    });

    it("set_model routes through sendSetModel", () => {
      bridge.handleConsumerMessage(
        consumerWs,
        "sess-1",
        JSON.stringify({ type: "set_model", model: "claude-opus-4-20250514" }),
      );

      const parsed = cliSocket.sentMessages.map((m) => JSON.parse(m.trim()));
      expect(
        parsed.some(
          (m: any) =>
            m.type === "control_request" &&
            m.request.subtype === "set_model" &&
            m.request.model === "claude-opus-4-20250514",
        ),
      ).toBe(true);
    });

    it("set_permission_mode routes through sendSetPermissionMode", () => {
      bridge.handleConsumerMessage(
        consumerWs,
        "sess-1",
        JSON.stringify({ type: "set_permission_mode", mode: "bypassPermissions" }),
      );

      const parsed = cliSocket.sentMessages.map((m) => JSON.parse(m.trim()));
      expect(
        parsed.some(
          (m: any) =>
            m.type === "control_request" &&
            m.request.subtype === "set_permission_mode" &&
            m.request.mode === "bypassPermissions",
        ),
      ).toBe(true);
    });

    it("set_adapter is handled without throwing (no-op)", () => {
      expect(() => {
        bridge.handleConsumerMessage(
          consumerWs,
          "sess-1",
          JSON.stringify({ type: "set_adapter", adapter: "codex" }),
        );
      }).not.toThrow();
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

    it("restoreFromStorage does not overwrite live sessions", () => {
      bridge.getOrCreateSession("sess-1");
      const cliSocket = createMockSocket();
      bridge.handleCLIOpen(cliSocket, "sess-1");
      bridge.handleCLIMessage("sess-1", makeInitMsg({ cwd: "/live" }));

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
      expect(bridge.getSession("sess-1")!.state.cwd).toBe("/live");
    });

    it("restoreFromStorage returns 0 when bridge has no storage", () => {
      const noStorageBridge = new SessionBridge({ config: { port: 3456 }, logger: noopLogger });
      const count = noStorageBridge.restoreFromStorage();
      expect(count).toBe(0);
    });

    it("persistSession is triggered by system init", () => {
      bridge.getOrCreateSession("sess-1");
      const cliSocket = createMockSocket();
      bridge.handleCLIOpen(cliSocket, "sess-1");

      bridge.handleCLIMessage("sess-1", makeInitMsg());

      const persisted = storage.load("sess-1");
      expect(persisted).not.toBeNull();
      expect(persisted!.state.model).toBe("claude-sonnet-4-5-20250929");
    });

    it("persistSession is triggered by assistant message", () => {
      bridge.getOrCreateSession("sess-1");
      const cliSocket = createMockSocket();
      bridge.handleCLIOpen(cliSocket, "sess-1");

      bridge.handleCLIMessage("sess-1", makeAssistantMsg());

      const persisted = storage.load("sess-1");
      expect(persisted).not.toBeNull();
      expect(persisted!.messageHistory.length).toBeGreaterThan(0);
    });

    it("persistSession is triggered by result message", () => {
      bridge.getOrCreateSession("sess-1");
      const cliSocket = createMockSocket();
      bridge.handleCLIOpen(cliSocket, "sess-1");

      bridge.handleCLIMessage("sess-1", makeResultMsg());

      const persisted = storage.load("sess-1");
      expect(persisted).not.toBeNull();
      expect(persisted!.state.total_cost_usd).toBe(0.01);
    });

    it("persistSession is triggered by control_request", () => {
      bridge.getOrCreateSession("sess-1");
      const cliSocket = createMockSocket();
      bridge.handleCLIOpen(cliSocket, "sess-1");

      bridge.handleCLIMessage("sess-1", makeControlRequestMsg());

      const persisted = storage.load("sess-1");
      expect(persisted).not.toBeNull();
      expect(persisted!.pendingPermissions.length).toBe(1);
    });

    it("persistSession is triggered by sendUserMessage", () => {
      bridge.getOrCreateSession("sess-1");
      const cliSocket = createMockSocket();
      bridge.handleCLIOpen(cliSocket, "sess-1");

      bridge.sendUserMessage("sess-1", "Hello");

      const persisted = storage.load("sess-1");
      expect(persisted).not.toBeNull();
      expect(persisted!.messageHistory.some((m) => m.type === "user_message")).toBe(true);
    });

    it("removeSession also removes from storage", () => {
      bridge.getOrCreateSession("sess-1");
      const cliSocket = createMockSocket();
      bridge.handleCLIOpen(cliSocket, "sess-1");
      bridge.handleCLIMessage("sess-1", makeInitMsg());

      expect(storage.load("sess-1")).not.toBeNull();

      bridge.removeSession("sess-1");
      expect(storage.load("sess-1")).toBeNull();
    });
  });

  // ── 8. Message history trimming ────────────────────────────────────────

  describe("Message history trimming (maxMessageHistoryLength)", () => {
    it("trims message history when exceeding maxMessageHistoryLength", () => {
      const { bridge: trimBridge } = createBridge({ maxMessageHistoryLength: 3 });
      trimBridge.getOrCreateSession("sess-1");
      const cliSocket = createMockSocket();
      trimBridge.handleCLIOpen(cliSocket, "sess-1");

      // Send 5 user messages
      for (let i = 0; i < 5; i++) {
        trimBridge.sendUserMessage("sess-1", `Message ${i}`);
      }

      const snapshot = trimBridge.getSession("sess-1")!;
      expect(snapshot.messageHistoryLength).toBe(3);
    });

    it("keeps the most recent messages after trimming", () => {
      const { bridge: trimBridge, storage: trimStorage } = createBridge({
        maxMessageHistoryLength: 2,
      });
      trimBridge.getOrCreateSession("sess-1");
      const cliSocket = createMockSocket();
      trimBridge.handleCLIOpen(cliSocket, "sess-1");

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

    it("assistant and result messages also count toward the limit", () => {
      const { bridge: trimBridge } = createBridge({ maxMessageHistoryLength: 2 });
      trimBridge.getOrCreateSession("sess-1");
      const cliSocket = createMockSocket();
      trimBridge.handleCLIOpen(cliSocket, "sess-1");

      // user message -> assistant -> result = 3 history entries, limit is 2
      trimBridge.sendUserMessage("sess-1", "hello");
      trimBridge.handleCLIMessage("sess-1", makeAssistantMsg());
      trimBridge.handleCLIMessage("sess-1", makeResultMsg());

      expect(trimBridge.getSession("sess-1")!.messageHistoryLength).toBe(2);
    });
  });

  // ── 9. Event emission ──────────────────────────────────────────────────

  describe("Event emission", () => {
    it("emits cli:session_id on system init", () => {
      bridge.getOrCreateSession("sess-1");
      const cliSocket = createMockSocket();
      bridge.handleCLIOpen(cliSocket, "sess-1");

      const handler = vi.fn();
      bridge.on("cli:session_id", handler);

      bridge.handleCLIMessage("sess-1", makeInitMsg({ session_id: "cli-xyz" }));

      expect(handler).toHaveBeenCalledWith({
        sessionId: "sess-1",
        cliSessionId: "cli-xyz",
      });
    });

    it("emits cli:connected on handleCLIOpen", () => {
      bridge.getOrCreateSession("sess-1");
      const handler = vi.fn();
      bridge.on("cli:connected", handler);

      bridge.handleCLIOpen(createMockSocket(), "sess-1");
      expect(handler).toHaveBeenCalledWith({ sessionId: "sess-1" });
    });

    it("emits cli:disconnected on handleCLIClose", () => {
      bridge.getOrCreateSession("sess-1");
      bridge.handleCLIOpen(createMockSocket(), "sess-1");

      const handler = vi.fn();
      bridge.on("cli:disconnected", handler);

      bridge.handleCLIClose("sess-1");
      expect(handler).toHaveBeenCalledWith({ sessionId: "sess-1" });
    });

    it("emits cli:relaunch_needed when consumer opens and CLI is dead", () => {
      bridge.getOrCreateSession("sess-1");
      const handler = vi.fn();
      bridge.on("cli:relaunch_needed", handler);

      bridge.handleConsumerOpen(createMockSocket(), authContext("sess-1"));
      expect(handler).toHaveBeenCalledWith({ sessionId: "sess-1" });
    });

    it("does not emit cli:relaunch_needed when CLI is connected", () => {
      bridge.getOrCreateSession("sess-1");
      bridge.handleCLIOpen(createMockSocket(), "sess-1");

      const handler = vi.fn();
      bridge.on("cli:relaunch_needed", handler);

      bridge.handleConsumerOpen(createMockSocket(), authContext("sess-1"));
      expect(handler).not.toHaveBeenCalled();
    });

    it("emits consumer:connected with correct count", () => {
      bridge.getOrCreateSession("sess-1");
      bridge.handleCLIOpen(createMockSocket(), "sess-1");

      const handler = vi.fn();
      bridge.on("consumer:connected", handler);

      bridge.handleConsumerOpen(createMockSocket(), authContext("sess-1"));
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: "sess-1", consumerCount: 1 }),
      );

      bridge.handleConsumerOpen(createMockSocket(), authContext("sess-1"));
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: "sess-1", consumerCount: 2 }),
      );
    });

    it("emits consumer:disconnected with correct count", () => {
      bridge.getOrCreateSession("sess-1");
      const ws1 = createMockSocket();
      const ws2 = createMockSocket();
      bridge.handleConsumerOpen(ws1, authContext("sess-1"));
      bridge.handleConsumerOpen(ws2, authContext("sess-1"));

      const handler = vi.fn();
      bridge.on("consumer:disconnected", handler);

      bridge.handleConsumerClose(ws1, "sess-1");
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: "sess-1", consumerCount: 1 }),
      );

      bridge.handleConsumerClose(ws2, "sess-1");
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: "sess-1", consumerCount: 0 }),
      );
    });

    it("emits message:outbound for every consumer broadcast", () => {
      bridge.getOrCreateSession("sess-1");
      const cliSocket = createMockSocket();
      bridge.handleCLIOpen(cliSocket, "sess-1");
      bridge.handleConsumerOpen(createMockSocket(), authContext("sess-1"));

      const handler = vi.fn();
      bridge.on("message:outbound", handler);

      bridge.handleCLIMessage("sess-1", makeAssistantMsg());

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: "sess-1",
          message: expect.objectContaining({ type: "assistant" }),
        }),
      );
    });

    it("emits message:inbound for every consumer message", () => {
      bridge.getOrCreateSession("sess-1");
      bridge.handleCLIOpen(createMockSocket(), "sess-1");
      const ws = createMockSocket();
      bridge.handleConsumerOpen(ws, authContext("sess-1"));

      const handler = vi.fn();
      bridge.on("message:inbound", handler);

      bridge.handleConsumerMessage(ws, "sess-1", JSON.stringify({ type: "interrupt" }));

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: "sess-1",
          message: { type: "interrupt" },
        }),
      );
    });

    it("emits permission:requested on control_request", () => {
      bridge.getOrCreateSession("sess-1");
      bridge.handleCLIOpen(createMockSocket(), "sess-1");

      const handler = vi.fn();
      bridge.on("permission:requested", handler);

      bridge.handleCLIMessage("sess-1", makeControlRequestMsg());

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: "sess-1",
          request: expect.objectContaining({
            request_id: "perm-req-1",
            tool_name: "Bash",
          }),
        }),
      );
    });

    it("emits permission:resolved when permission response is sent", () => {
      bridge.getOrCreateSession("sess-1");
      bridge.handleCLIOpen(createMockSocket(), "sess-1");
      bridge.handleCLIMessage("sess-1", makeControlRequestMsg());

      const handler = vi.fn();
      bridge.on("permission:resolved", handler);

      bridge.sendPermissionResponse("sess-1", "perm-req-1", "deny");

      expect(handler).toHaveBeenCalledWith({
        sessionId: "sess-1",
        requestId: "perm-req-1",
        behavior: "deny",
      });
    });

    it("emits session:first_turn_completed on successful first turn", () => {
      bridge.getOrCreateSession("sess-1");
      bridge.handleCLIOpen(createMockSocket(), "sess-1");
      bridge.sendUserMessage("sess-1", "Explain monads");

      const handler = vi.fn();
      bridge.on("session:first_turn_completed", handler);

      bridge.handleCLIMessage("sess-1", makeResultMsg({ num_turns: 1, is_error: false }));

      expect(handler).toHaveBeenCalledWith({
        sessionId: "sess-1",
        firstUserMessage: "Explain monads",
      });
    });

    it("emits session:closed on closeSession", () => {
      bridge.getOrCreateSession("sess-1");
      const handler = vi.fn();
      bridge.on("session:closed", handler);

      bridge.closeSession("sess-1");
      expect(handler).toHaveBeenCalledWith({ sessionId: "sess-1" });
    });

    it("emits auth_status on auth_status CLI message", () => {
      bridge.getOrCreateSession("sess-1");
      bridge.handleCLIOpen(createMockSocket(), "sess-1");

      const handler = vi.fn();
      bridge.on("auth_status", handler);

      bridge.handleCLIMessage(
        "sess-1",
        makeAuthStatusMsg({ isAuthenticating: false, error: "Auth failed" }),
      );

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: "sess-1",
          isAuthenticating: false,
          error: "Auth failed",
        }),
      );
    });

    it("emits error when sendToCLI fails", () => {
      bridge.getOrCreateSession("sess-1");
      const failSocket = createMockSocket();
      failSocket.send = vi.fn(() => {
        throw new Error("Socket write failed");
      });
      bridge.handleCLIOpen(failSocket, "sess-1");

      const handler = vi.fn();
      bridge.on("error", handler);

      bridge.sendInterrupt("sess-1");

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          source: "sendToCLI",
          error: expect.any(Error),
          sessionId: "sess-1",
        }),
      );
    });
  });

  // ── 10. Edge cases ─────────────────────────────────────────────────────

  describe("Edge cases", () => {
    it("queues messages when CLI is not connected (I5)", () => {
      bridge.getOrCreateSession("sess-1");
      // No CLI socket connected

      bridge.sendUserMessage("sess-1", "Will be queued");
      bridge.sendInterrupt("sess-1");

      // Now connect CLI
      const cliSocket = createMockSocket();
      bridge.handleCLIOpen(cliSocket, "sess-1");

      // The queued user message should have been flushed
      const sentToCli = cliSocket.sentMessages.map((m) => JSON.parse(m.trim()));
      expect(sentToCli.some((m: any) => m.type === "user")).toBe(true);
    });

    it("unknown permission request_ids produce no CLI message (S4)", () => {
      bridge.getOrCreateSession("sess-1");
      const cliSocket = createMockSocket();
      bridge.handleCLIOpen(cliSocket, "sess-1");
      cliSocket.sentMessages.length = 0;

      // No permission was requested, try to respond anyway
      bridge.sendPermissionResponse("sess-1", "unknown-request-id", "allow");

      expect(cliSocket.sentMessages).toHaveLength(0);
    });

    it("permission response with updatedPermissions includes them", () => {
      bridge.getOrCreateSession("sess-1");
      const cliSocket = createMockSocket();
      bridge.handleCLIOpen(cliSocket, "sess-1");
      bridge.handleCLIMessage("sess-1", makeControlRequestMsg());
      cliSocket.sentMessages.length = 0;

      bridge.sendPermissionResponse("sess-1", "perm-req-1", "allow", {
        updatedPermissions: [{ type: "setMode", mode: "plan", destination: "session" }],
      });

      const parsed = JSON.parse(cliSocket.sentMessages[0].trim());
      expect(parsed.response.response.updatedPermissions).toEqual([
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

    it("handleCLIMessage handles Buffer input", () => {
      bridge.getOrCreateSession("sess-1");
      const cliSocket = createMockSocket();
      bridge.handleCLIOpen(cliSocket, "sess-1");
      const consumerSocket = createMockSocket();
      bridge.handleConsumerOpen(consumerSocket, authContext("sess-1"));
      consumerSocket.sentMessages.length = 0;

      const bufferData = Buffer.from(makeAssistantMsg());
      bridge.handleCLIMessage("sess-1", bufferData);

      const parsed = consumerSocket.sentMessages.map((m) => JSON.parse(m));
      expect(parsed.some((m: any) => m.type === "assistant")).toBe(true);
    });

    it("handleConsumerMessage handles Buffer input", () => {
      bridge.getOrCreateSession("sess-1");
      const cliSocket = createMockSocket();
      bridge.handleCLIOpen(cliSocket, "sess-1");
      const ws = createMockSocket();
      bridge.handleConsumerOpen(ws, authContext("sess-1"));
      cliSocket.sentMessages.length = 0;

      const bufferData = Buffer.from(JSON.stringify({ type: "interrupt" }));
      bridge.handleConsumerMessage(ws, "sess-1", bufferData);

      const parsed = cliSocket.sentMessages.map((m) => JSON.parse(m.trim()));
      expect(parsed.some((m: any) => m.request?.subtype === "interrupt")).toBe(true);
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

    it("consumer socket that throws on send is removed from the set", () => {
      bridge.getOrCreateSession("sess-1");
      const cliSocket = createMockSocket();
      bridge.handleCLIOpen(cliSocket, "sess-1");

      const failSocket = createMockSocket();
      failSocket.send = vi.fn(() => {
        throw new Error("Write failed");
      });
      bridge.handleConsumerOpen(failSocket, authContext("sess-1"));

      // Trigger a broadcast that will cause failSocket to throw
      bridge.handleCLIMessage("sess-1", makeAssistantMsg());

      // After the failed send, the consumer count should be reduced
      // (the socket was removed from the set during broadcast)
      expect(bridge.getSession("sess-1")!.consumerCount).toBe(0);
    });

    it("multiple consumers all receive the same broadcast", () => {
      bridge.getOrCreateSession("sess-1");
      const cliSocket = createMockSocket();
      bridge.handleCLIOpen(cliSocket, "sess-1");

      const consumer1 = createMockSocket();
      const consumer2 = createMockSocket();
      const consumer3 = createMockSocket();
      bridge.handleConsumerOpen(consumer1, authContext("sess-1"));
      bridge.handleConsumerOpen(consumer2, authContext("sess-1"));
      bridge.handleConsumerOpen(consumer3, authContext("sess-1"));

      consumer1.sentMessages.length = 0;
      consumer2.sentMessages.length = 0;
      consumer3.sentMessages.length = 0;

      bridge.handleCLIMessage("sess-1", makeAssistantMsg());

      for (const consumer of [consumer1, consumer2, consumer3]) {
        const parsed = consumer.sentMessages.map((m) => JSON.parse(m));
        expect(parsed.some((m: any) => m.type === "assistant")).toBe(true);
      }
    });

    it("closeSession handles CLI socket close error gracefully", () => {
      bridge.getOrCreateSession("sess-1");
      const cliSocket = createMockSocket();
      cliSocket.close = vi.fn(() => {
        throw new Error("Already closed");
      });
      bridge.handleCLIOpen(cliSocket, "sess-1");

      // Should not throw
      expect(() => bridge.closeSession("sess-1")).not.toThrow();
      expect(bridge.getSession("sess-1")).toBeUndefined();
    });

    it("closeSession handles consumer socket close error gracefully", () => {
      bridge.getOrCreateSession("sess-1");
      const consumerSocket = createMockSocket();
      consumerSocket.close = vi.fn(() => {
        throw new Error("Already closed");
      });
      bridge.handleConsumerOpen(consumerSocket, authContext("sess-1"));

      expect(() => bridge.closeSession("sess-1")).not.toThrow();
      expect(bridge.getSession("sess-1")).toBeUndefined();
    });

    it("sendUserMessage with user_message via consumer includes session_id override", () => {
      bridge.getOrCreateSession("sess-1");
      const cliSocket = createMockSocket();
      bridge.handleCLIOpen(cliSocket, "sess-1");
      // First populate the CLI session_id via init
      bridge.handleCLIMessage("sess-1", makeInitMsg({ session_id: "cli-real-id" }));
      const ws = createMockSocket();
      bridge.handleConsumerOpen(ws, authContext("sess-1"));
      cliSocket.sentMessages.length = 0;

      bridge.handleConsumerMessage(
        ws,
        "sess-1",
        JSON.stringify({ type: "user_message", content: "test", session_id: "cli-real-id" }),
      );

      const parsed = cliSocket.sentMessages.map((m) => JSON.parse(m.trim()));
      expect(parsed[0].session_id).toBe("cli-real-id");
    });

    it("deny permission response uses default message when none provided", () => {
      bridge.getOrCreateSession("sess-1");
      const cliSocket = createMockSocket();
      bridge.handleCLIOpen(cliSocket, "sess-1");
      bridge.handleCLIMessage("sess-1", makeControlRequestMsg());
      cliSocket.sentMessages.length = 0;

      bridge.sendPermissionResponse("sess-1", "perm-req-1", "deny");

      const parsed = JSON.parse(cliSocket.sentMessages[0].trim());
      expect(parsed.response.response.message).toBe("Denied by user");
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

  // ── backend:* dual-emit events ──────────────────────────────────────────

  describe("backend:* dual-emit events", () => {
    it("emits backend:connected alongside cli:connected on handleCLIOpen", () => {
      bridge.getOrCreateSession("sess-1");
      const cliHandler = vi.fn();
      const backendHandler = vi.fn();
      bridge.on("cli:connected", cliHandler);
      bridge.on("backend:connected", backendHandler);

      bridge.handleCLIOpen(createMockSocket(), "sess-1");

      expect(cliHandler).toHaveBeenCalledWith({ sessionId: "sess-1" });
      expect(backendHandler).toHaveBeenCalledWith({ sessionId: "sess-1" });
    });

    it("emits backend:disconnected alongside cli:disconnected on handleCLIClose", () => {
      bridge.getOrCreateSession("sess-1");
      bridge.handleCLIOpen(createMockSocket(), "sess-1");

      const cliHandler = vi.fn();
      const backendHandler = vi.fn();
      bridge.on("cli:disconnected", cliHandler);
      bridge.on("backend:disconnected", backendHandler);

      bridge.handleCLIClose("sess-1");

      expect(cliHandler).toHaveBeenCalledWith({ sessionId: "sess-1" });
      expect(backendHandler).toHaveBeenCalledWith({
        sessionId: "sess-1",
        code: 1000,
        reason: "CLI process disconnected",
      });
    });

    it("emits backend:session_id alongside cli:session_id on system init", () => {
      bridge.getOrCreateSession("sess-1");
      bridge.handleCLIOpen(createMockSocket(), "sess-1");

      const cliHandler = vi.fn();
      const backendHandler = vi.fn();
      bridge.on("cli:session_id", cliHandler);
      bridge.on("backend:session_id", backendHandler);

      bridge.handleCLIMessage("sess-1", makeInitMsg({ session_id: "cli-abc" }));

      expect(cliHandler).toHaveBeenCalledWith({
        sessionId: "sess-1",
        cliSessionId: "cli-abc",
      });
      expect(backendHandler).toHaveBeenCalledWith({
        sessionId: "sess-1",
        backendSessionId: "cli-abc",
      });
    });

    it("emits backend:relaunch_needed alongside cli:relaunch_needed when consumer opens and CLI is dead", () => {
      bridge.getOrCreateSession("sess-1");
      const cliHandler = vi.fn();
      const backendHandler = vi.fn();
      bridge.on("cli:relaunch_needed", cliHandler);
      bridge.on("backend:relaunch_needed", backendHandler);

      bridge.handleConsumerOpen(createMockSocket(), authContext("sess-1"));

      expect(cliHandler).toHaveBeenCalledWith({ sessionId: "sess-1" });
      expect(backendHandler).toHaveBeenCalledWith({ sessionId: "sess-1" });
    });

    it("does not emit backend:relaunch_needed when CLI is connected", () => {
      bridge.getOrCreateSession("sess-1");
      bridge.handleCLIOpen(createMockSocket(), "sess-1");

      const handler = vi.fn();
      bridge.on("backend:relaunch_needed", handler);

      bridge.handleConsumerOpen(createMockSocket(), authContext("sess-1"));
      expect(handler).not.toHaveBeenCalled();
    });
  });

  // ─── Error path coverage (Task 11) ─────────────────────────────────────

  describe("error paths", () => {
    it("handleCLIMessage with corrupted/partial NDJSON → no crash, logged", () => {
      const cliSocket = createMockSocket();
      const ws = createMockSocket();

      bridge.handleCLIOpen(cliSocket, "sess-1");
      bridge.handleConsumerOpen(ws, authContext("sess-1"));

      // Should not throw
      expect(() => {
        bridge.handleCLIMessage("sess-1", "not valid json\n{also bad");
      }).not.toThrow();
    });

    it("handleConsumerMessage exceeding MAX_CONSUMER_MESSAGE_SIZE → socket closed with 1009", () => {
      const cliSocket = createMockSocket();
      const ws = createMockSocket();

      bridge.handleCLIOpen(cliSocket, "sess-1");
      bridge.handleConsumerOpen(ws, authContext("sess-1"));
      bridge.handleCLIMessage("sess-1", makeInitMsg());

      // 256KB + 1
      const oversized = "x".repeat(262_145);
      bridge.handleConsumerMessage(ws, "sess-1", oversized);

      expect(ws.close).toHaveBeenCalledWith(1009, "Message Too Big");
    });

    it("sendToCLI when CLI socket is null → message queued to pendingMessages", () => {
      const ws = createMockSocket();
      bridge.handleConsumerOpen(ws, authContext("sess-1"));

      // Send a consumer message without CLI being connected
      bridge.handleConsumerMessage(
        ws,
        "sess-1",
        JSON.stringify({ type: "user_message", content: "hello" }),
      );

      // Verify message was queued by connecting CLI and checking flush
      const cliSocket = createMockSocket();
      bridge.handleCLIOpen(cliSocket, "sess-1");
      bridge.handleCLIMessage("sess-1", makeInitMsg());

      // After CLI connects, queued messages should flush.
      // The consumer "user_message" is transformed to NDJSON { type: "user", ... }
      const flushed = cliSocket.sentMessages.some((m: string) => m.includes('"type":"user"'));
      expect(flushed).toBe(true);
    });

    it("consumer open with unknown session → session auto-created", () => {
      const ws = createMockSocket();

      // No CLI has connected to "new-session" yet
      bridge.handleConsumerOpen(ws, authContext("new-session"));

      // Session should be auto-created
      const snapshot = bridge.getSession("new-session");
      expect(snapshot).toBeDefined();
      expect(snapshot!.consumerCount).toBe(1);
    });

    it("closeSession when cliSocket.close() throws → session still removed", () => {
      const cliSocket = createMockSocket();
      cliSocket.close.mockImplementation(() => {
        throw new Error("close boom");
      });

      bridge.handleCLIOpen(cliSocket, "sess-close");
      bridge.handleCLIMessage("sess-close", makeInitMsg({ session_id: "cli-close" }));

      // Should not throw
      expect(() => bridge.closeSession("sess-close")).not.toThrow();
      expect(bridge.getSession("sess-close")).toBeUndefined();
    });

    it("consumer message for session with no CLI → does not crash", () => {
      const ws = createMockSocket();
      bridge.handleConsumerOpen(ws, authContext("no-cli"));

      // Try to send a message without any CLI
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

      // resolve called only once — second call skips due to git_branch already set
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
      // Simulate consumer connecting — would call resolveGitInfo again
      const ws = createMockSocket();
      gitBridge.handleConsumerOpen(ws, authContext("seed-5"));

      // resolve called only once — second call skipped due to attempt tracking
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

    it("consumer connecting before CLI receives seeded state in session_init", () => {
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

      // Consumer connects before CLI
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
