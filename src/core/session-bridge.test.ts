import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:crypto", () => ({ randomUUID: () => "test-uuid" }));

import { MemoryStorage } from "../adapters/memory-storage.js";
import type { AuthContext, Authenticator, ConsumerIdentity } from "../interfaces/auth.js";
import type { WebSocketLike } from "../interfaces/transport.js";
import { SessionBridge } from "./session-bridge.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createMockSocket(): WebSocketLike & {
  sentMessages: string[];
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
} {
  const sentMessages: string[] = [];
  return {
    send: vi.fn((data: string) => sentMessages.push(data)),
    close: vi.fn(),
    sentMessages,
  };
}

const noopLogger = { debug() {}, info() {}, warn() {}, error() {} };

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

function authContext(sessionId: string, transport: Record<string, unknown> = {}): AuthContext {
  return { sessionId, transport };
}

function makeInitMsg(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: "system",
    subtype: "init",
    session_id: "cli-123",
    model: "claude-sonnet-4-5-20250929",
    cwd: "/test",
    tools: ["Bash", "Read"],
    permissionMode: "default",
    claude_code_version: "1.0",
    mcp_servers: [],
    agents: [],
    slash_commands: [],
    skills: [],
    output_style: "normal",
    uuid: "uuid-1",
    apiKeySource: "env",
    ...overrides,
  });
}

function makeStatusMsg(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: "system",
    subtype: "status",
    status: null,
    uuid: "uuid-status",
    session_id: "cli-123",
    ...overrides,
  });
}

function makeAssistantMsg(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: "assistant",
    message: {
      id: "msg-1",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-5-20250929",
      content: [{ type: "text", text: "Hello world" }],
      stop_reason: "end_turn",
      usage: {
        input_tokens: 10,
        output_tokens: 20,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
    parent_tool_use_id: null,
    uuid: "uuid-2",
    session_id: "cli-123",
    ...overrides,
  });
}

function makeResultMsg(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "Done",
    duration_ms: 1000,
    duration_api_ms: 800,
    num_turns: 1,
    total_cost_usd: 0.01,
    stop_reason: "end_turn",
    usage: {
      input_tokens: 100,
      output_tokens: 200,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    uuid: "uuid-3",
    session_id: "cli-123",
    ...overrides,
  });
}

function makeStreamEventMsg(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: "stream_event",
    event: { type: "content_block_delta", delta: { type: "text_delta", text: "hi" } },
    parent_tool_use_id: null,
    uuid: "uuid-4",
    session_id: "cli-123",
    ...overrides,
  });
}

function makeControlRequestMsg(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: "control_request",
    request_id: "perm-req-1",
    request: {
      subtype: "can_use_tool",
      tool_name: "Bash",
      input: { command: "ls" },
      tool_use_id: "tu-1",
      ...((overrides.request as Record<string, unknown>) ?? {}),
    },
    ...Object.fromEntries(Object.entries(overrides).filter(([k]) => k !== "request")),
  });
}

function makeToolProgressMsg(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: "tool_progress",
    tool_use_id: "tu-1",
    tool_name: "Bash",
    parent_tool_use_id: null,
    elapsed_time_seconds: 5,
    uuid: "uuid-5",
    session_id: "cli-123",
    ...overrides,
  });
}

function makeToolUseSummaryMsg(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: "tool_use_summary",
    summary: "Ran bash command",
    preceding_tool_use_ids: ["tu-1", "tu-2"],
    uuid: "uuid-6",
    session_id: "cli-123",
    ...overrides,
  });
}

function makeAuthStatusMsg(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: "auth_status",
    isAuthenticating: true,
    output: ["Authenticating..."],
    uuid: "uuid-7",
    session_id: "cli-123",
    ...overrides,
  });
}

function makeKeepAliveMsg() {
  return JSON.stringify({ type: "keep_alive" });
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

  // ── 11. Authentication ──────────────────────────────────────────────────

  describe("Authentication", () => {
    it("rejects consumer when authenticator throws", async () => {
      const authenticator: Authenticator = {
        authenticate: vi.fn().mockRejectedValue(new Error("Invalid token")),
      };
      const { bridge: authBridge } = createBridge({ authenticator });
      authBridge.getOrCreateSession("sess-1");

      const failedHandler = vi.fn();
      authBridge.on("consumer:auth_failed", failedHandler);

      const ws = createMockSocket();
      authBridge.handleConsumerOpen(ws, authContext("sess-1"));

      // Let the authenticator promise reject
      await new Promise((r) => setTimeout(r, 0));

      expect(ws.close).toHaveBeenCalledWith(4001, "Authentication failed");
      expect(failedHandler).toHaveBeenCalledWith({
        sessionId: "sess-1",
        reason: "Invalid token",
      });
    });

    it("accepts consumer when authenticator resolves", async () => {
      const identity: ConsumerIdentity = {
        userId: "user-42",
        displayName: "Alice",
        role: "participant",
      };
      const authenticator: Authenticator = {
        authenticate: vi.fn().mockResolvedValue(identity),
      };
      const { bridge: authBridge } = createBridge({ authenticator });
      authBridge.getOrCreateSession("sess-1");

      const authedHandler = vi.fn();
      authBridge.on("consumer:authenticated", authedHandler);

      const ws = createMockSocket();
      authBridge.handleConsumerOpen(ws, authContext("sess-1"));

      await new Promise((r) => setTimeout(r, 0));

      expect(ws.close).not.toHaveBeenCalled();
      const parsed = ws.sentMessages.map((m) => JSON.parse(m));
      expect(parsed.some((m: any) => m.type === "identity")).toBe(true);
      expect(parsed.some((m: any) => m.type === "session_init")).toBe(true);
      expect(authedHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: "sess-1",
          userId: "user-42",
          displayName: "Alice",
          role: "participant",
        }),
      );
    });

    it("sends identity message to authenticated consumer", async () => {
      const identity: ConsumerIdentity = {
        userId: "user-99",
        displayName: "Bob",
        role: "observer",
      };
      const authenticator: Authenticator = {
        authenticate: vi.fn().mockResolvedValue(identity),
      };
      const { bridge: authBridge } = createBridge({ authenticator });
      authBridge.getOrCreateSession("sess-1");

      const ws = createMockSocket();
      authBridge.handleConsumerOpen(ws, authContext("sess-1"));

      await new Promise((r) => setTimeout(r, 0));

      const parsed = ws.sentMessages.map((m) => JSON.parse(m));
      const identityMsg = parsed.find((m: any) => m.type === "identity");
      expect(identityMsg).toEqual({
        type: "identity",
        userId: "user-99",
        displayName: "Bob",
        role: "observer",
      });
    });

    it("assigns anonymous identity when no authenticator (dev mode)", () => {
      bridge.getOrCreateSession("sess-1");
      const ws = createMockSocket();
      bridge.handleConsumerOpen(ws, authContext("sess-1"));

      const parsed = ws.sentMessages.map((m) => JSON.parse(m));
      const identityMsg = parsed.find((m: any) => m.type === "identity");
      expect(identityMsg).toEqual({
        type: "identity",
        userId: "anonymous-1",
        displayName: "User 1",
        role: "participant",
      });
    });

    it("authenticator receives correct sessionId in context", async () => {
      const authenticator: Authenticator = {
        authenticate: vi.fn().mockResolvedValue({
          userId: "u1",
          displayName: "U1",
          role: "participant",
        }),
      };
      const { bridge: authBridge } = createBridge({ authenticator });
      authBridge.getOrCreateSession("my-session");

      const ws = createMockSocket();
      authBridge.handleConsumerOpen(ws, authContext("my-session"));

      await new Promise((r) => setTimeout(r, 0));

      expect(authenticator.authenticate).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: "my-session" }),
      );
    });

    it("authenticator receives transport metadata", async () => {
      const authenticator: Authenticator = {
        authenticate: vi.fn().mockResolvedValue({
          userId: "u1",
          displayName: "U1",
          role: "participant",
        }),
      };
      const { bridge: authBridge } = createBridge({ authenticator });
      authBridge.getOrCreateSession("sess-1");

      const ws = createMockSocket();
      const transport = { headers: { authorization: "Bearer abc" }, query: { token: "xyz" } };
      authBridge.handleConsumerOpen(ws, { sessionId: "sess-1", transport });

      await new Promise((r) => setTimeout(r, 0));

      expect(authenticator.authenticate).toHaveBeenCalledWith(
        expect.objectContaining({
          transport: expect.objectContaining({ headers: { authorization: "Bearer abc" } }),
        }),
      );
    });
  });

  // ── 12. Role-based authorization ────────────────────────────────────────

  describe("Role-based authorization", () => {
    function createObserverBridge() {
      const identity: ConsumerIdentity = {
        userId: "obs-1",
        displayName: "Observer",
        role: "observer",
      };
      const authenticator: Authenticator = {
        authenticate: vi.fn().mockResolvedValue(identity),
      };
      return createBridge({ authenticator });
    }

    async function connectObserver(b: SessionBridge, sessionId: string) {
      b.getOrCreateSession(sessionId);
      const ws = createMockSocket();
      b.handleConsumerOpen(ws, authContext(sessionId));
      await new Promise((r) => setTimeout(r, 0));
      ws.sentMessages.length = 0;
      return ws;
    }

    it("observer receives all broadcast messages", async () => {
      const { bridge: obsBridge } = createObserverBridge();
      obsBridge.getOrCreateSession("sess-1");
      const cliSocket = createMockSocket();
      obsBridge.handleCLIOpen(cliSocket, "sess-1");

      const ws = createMockSocket();
      obsBridge.handleConsumerOpen(ws, authContext("sess-1"));
      await new Promise((r) => setTimeout(r, 0));
      ws.sentMessages.length = 0;

      obsBridge.handleCLIMessage("sess-1", makeAssistantMsg());

      const parsed = ws.sentMessages.map((m) => JSON.parse(m));
      expect(parsed.some((m: any) => m.type === "assistant")).toBe(true);
    });

    it("observer blocked from user_message", async () => {
      const { bridge: obsBridge } = createObserverBridge();
      const cliSocket = createMockSocket();
      obsBridge.getOrCreateSession("sess-1");
      obsBridge.handleCLIOpen(cliSocket, "sess-1");

      const ws = await connectObserver(obsBridge, "sess-1");
      cliSocket.sentMessages.length = 0;

      obsBridge.handleConsumerMessage(
        ws,
        "sess-1",
        JSON.stringify({ type: "user_message", content: "hello" }),
      );

      // Should NOT reach CLI
      expect(cliSocket.sentMessages).toHaveLength(0);

      // Should get error back
      const parsed = ws.sentMessages.map((m) => JSON.parse(m));
      expect(parsed.some((m: any) => m.type === "error")).toBe(true);
    });

    it("observer blocked from permission_response", async () => {
      const { bridge: obsBridge } = createObserverBridge();
      const cliSocket = createMockSocket();
      obsBridge.getOrCreateSession("sess-1");
      obsBridge.handleCLIOpen(cliSocket, "sess-1");
      obsBridge.handleCLIMessage("sess-1", makeControlRequestMsg());

      const ws = await connectObserver(obsBridge, "sess-1");
      cliSocket.sentMessages.length = 0;

      obsBridge.handleConsumerMessage(
        ws,
        "sess-1",
        JSON.stringify({
          type: "permission_response",
          request_id: "perm-req-1",
          behavior: "allow",
        }),
      );

      expect(cliSocket.sentMessages).toHaveLength(0);
      const parsed = ws.sentMessages.map((m) => JSON.parse(m));
      expect(parsed.some((m: any) => m.type === "error")).toBe(true);
    });

    it("observer blocked from interrupt", async () => {
      const { bridge: obsBridge } = createObserverBridge();
      const cliSocket = createMockSocket();
      obsBridge.getOrCreateSession("sess-1");
      obsBridge.handleCLIOpen(cliSocket, "sess-1");

      const ws = await connectObserver(obsBridge, "sess-1");
      cliSocket.sentMessages.length = 0;

      obsBridge.handleConsumerMessage(ws, "sess-1", JSON.stringify({ type: "interrupt" }));

      expect(cliSocket.sentMessages).toHaveLength(0);
      const parsed = ws.sentMessages.map((m) => JSON.parse(m));
      expect(parsed.some((m: any) => m.type === "error")).toBe(true);
    });

    it("observer blocked from set_model", async () => {
      const { bridge: obsBridge } = createObserverBridge();
      const cliSocket = createMockSocket();
      obsBridge.getOrCreateSession("sess-1");
      obsBridge.handleCLIOpen(cliSocket, "sess-1");

      const ws = await connectObserver(obsBridge, "sess-1");
      cliSocket.sentMessages.length = 0;

      obsBridge.handleConsumerMessage(
        ws,
        "sess-1",
        JSON.stringify({ type: "set_model", model: "claude-opus-4-20250514" }),
      );

      expect(cliSocket.sentMessages).toHaveLength(0);
      const parsed = ws.sentMessages.map((m) => JSON.parse(m));
      expect(parsed.some((m: any) => m.type === "error")).toBe(true);
    });

    it("observer blocked from set_permission_mode", async () => {
      const { bridge: obsBridge } = createObserverBridge();
      const cliSocket = createMockSocket();
      obsBridge.getOrCreateSession("sess-1");
      obsBridge.handleCLIOpen(cliSocket, "sess-1");

      const ws = await connectObserver(obsBridge, "sess-1");
      cliSocket.sentMessages.length = 0;

      obsBridge.handleConsumerMessage(
        ws,
        "sess-1",
        JSON.stringify({ type: "set_permission_mode", mode: "plan" }),
      );

      expect(cliSocket.sentMessages).toHaveLength(0);
      const parsed = ws.sentMessages.map((m) => JSON.parse(m));
      expect(parsed.some((m: any) => m.type === "error")).toBe(true);
    });

    it("observer receives error message when blocked", async () => {
      const { bridge: obsBridge } = createObserverBridge();
      const cliSocket = createMockSocket();
      obsBridge.getOrCreateSession("sess-1");
      obsBridge.handleCLIOpen(cliSocket, "sess-1");

      const ws = await connectObserver(obsBridge, "sess-1");

      obsBridge.handleConsumerMessage(
        ws,
        "sess-1",
        JSON.stringify({ type: "user_message", content: "hello" }),
      );

      const parsed = ws.sentMessages.map((m) => JSON.parse(m));
      const errorMsg = parsed.find((m: any) => m.type === "error");
      expect(errorMsg).toBeDefined();
      expect(errorMsg.message).toBe("Observers cannot send user_message messages");
    });

    it("participant can send all message types", () => {
      // Default anonymous is participant
      bridge.getOrCreateSession("sess-1");
      const cliSocket = createMockSocket();
      bridge.handleCLIOpen(cliSocket, "sess-1");

      const ws = createMockSocket();
      bridge.handleConsumerOpen(ws, authContext("sess-1"));
      cliSocket.sentMessages.length = 0;

      bridge.handleConsumerMessage(
        ws,
        "sess-1",
        JSON.stringify({ type: "user_message", content: "hello from participant" }),
      );

      const parsed = cliSocket.sentMessages.map((m) => JSON.parse(m.trim()));
      expect(parsed.some((m: any) => m.type === "user")).toBe(true);
    });

    it("observer can send presence_query", async () => {
      const { bridge: obsBridge } = createObserverBridge();
      obsBridge.getOrCreateSession("sess-1");

      const ws = await connectObserver(obsBridge, "sess-1");
      ws.sentMessages.length = 0;

      obsBridge.handleConsumerMessage(ws, "sess-1", JSON.stringify({ type: "presence_query" }));

      // Should NOT get error
      const parsed = ws.sentMessages.map((m) => JSON.parse(m));
      expect(parsed.some((m: any) => m.type === "error")).toBe(false);
      // Should get presence_update instead
      expect(parsed.some((m: any) => m.type === "presence_update")).toBe(true);
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

  // ── 14. Edge cases ──────────────────────────────────────────────────────

  describe("Edge cases", () => {
    it("messages from unregistered sockets are silently dropped", () => {
      bridge.getOrCreateSession("sess-1");
      const cliSocket = createMockSocket();
      bridge.handleCLIOpen(cliSocket, "sess-1");
      cliSocket.sentMessages.length = 0;

      // ws is NOT registered as a consumer — never called handleConsumerOpen
      const ws = createMockSocket();
      bridge.handleConsumerMessage(
        ws,
        "sess-1",
        JSON.stringify({ type: "user_message", content: "sneaky" }),
      );

      // Nothing forwarded to CLI
      expect(cliSocket.sentMessages).toHaveLength(0);
      // No error sent to unregistered socket either
      expect(ws.sentMessages).toHaveLength(0);
    });

    it("messages during pending auth are silently dropped", async () => {
      let resolveAuth!: (id: ConsumerIdentity) => void;
      const authenticator: Authenticator = {
        authenticate: () =>
          new Promise((resolve) => {
            resolveAuth = resolve;
          }),
      };
      const { bridge: authBridge } = createBridge({ authenticator });
      authBridge.getOrCreateSession("sess-1");
      const cliSocket = createMockSocket();
      authBridge.handleCLIOpen(cliSocket, "sess-1");

      const ws = createMockSocket();
      authBridge.handleConsumerOpen(ws, authContext("sess-1"));

      // Auth still pending — try to send a message
      cliSocket.sentMessages.length = 0;
      authBridge.handleConsumerMessage(
        ws,
        "sess-1",
        JSON.stringify({ type: "user_message", content: "too early" }),
      );

      // Dropped — socket not yet in map
      expect(cliSocket.sentMessages).toHaveLength(0);

      // Now resolve auth
      resolveAuth({ userId: "u1", displayName: "User 1", role: "participant" });
      await new Promise((r) => setTimeout(r, 0));

      // Now message should work
      authBridge.handleConsumerMessage(
        ws,
        "sess-1",
        JSON.stringify({ type: "user_message", content: "now it works" }),
      );
      expect(cliSocket.sentMessages.length).toBeGreaterThan(0);
    });

    it("synchronous authenticator throw is caught", () => {
      const authenticator: Authenticator = {
        authenticate: () => {
          throw new Error("sync boom");
        },
      };
      const { bridge: authBridge } = createBridge({ authenticator });
      authBridge.getOrCreateSession("sess-1");

      const events: unknown[] = [];
      authBridge.on("consumer:auth_failed", (e) => events.push(e));

      const ws = createMockSocket();
      // Should not throw
      authBridge.handleConsumerOpen(ws, authContext("sess-1"));

      expect(events).toHaveLength(1);
      expect(ws.close).toHaveBeenCalledWith(4001, "Authentication failed");
    });

    it("auth timeout rejects slow authenticators", async () => {
      const authenticator: Authenticator = {
        authenticate: () => new Promise(() => {}), // never resolves
      };
      // Override authTimeoutMs via config
      const fastBridge = new SessionBridge({
        authenticator,
        config: { port: 3456, authTimeoutMs: 50 },
        logger: noopLogger,
      });
      fastBridge.getOrCreateSession("sess-1");

      const events: unknown[] = [];
      fastBridge.on("consumer:auth_failed", (e) => events.push(e));

      const ws = createMockSocket();
      fastBridge.handleConsumerOpen(ws, authContext("sess-1"));

      // Wait for timeout
      await new Promise((r) => setTimeout(r, 100));

      expect(events).toHaveLength(1);
      expect((events[0] as any).reason).toBe("Authentication timed out");
      expect(ws.close).toHaveBeenCalledWith(4001, "Authentication failed");
    });

    it("session removed during async auth rejects consumer", async () => {
      const authenticator: Authenticator = {
        authenticate: vi.fn().mockResolvedValue({
          userId: "u1",
          displayName: "User 1",
          role: "participant",
        }),
      };
      const { bridge: authBridge } = createBridge({ authenticator });
      authBridge.getOrCreateSession("sess-1");

      const events: unknown[] = [];
      authBridge.on("consumer:auth_failed", (e) => events.push(e));

      const ws = createMockSocket();
      authBridge.handleConsumerOpen(ws, authContext("sess-1"));

      // Remove session before auth resolves
      authBridge.removeSession("sess-1");

      await new Promise((r) => setTimeout(r, 0));

      expect(events).toHaveLength(1);
      expect((events[0] as any).reason).toBe("Session closed during authentication");
      expect(ws.close).toHaveBeenCalledWith(4001, "Authentication failed");
    });

    it("permission cancellations on CLI disconnect are only sent to participants", async () => {
      const identity: ConsumerIdentity = {
        userId: "obs-1",
        displayName: "Observer",
        role: "observer",
      };
      const participantIdentity: ConsumerIdentity = {
        userId: "part-1",
        displayName: "Participant",
        role: "participant",
      };
      let callCount = 0;
      const authenticator: Authenticator = {
        authenticate: () => {
          callCount++;
          return Promise.resolve(callCount === 1 ? participantIdentity : identity);
        },
      };
      const { bridge: authBridge } = createBridge({ authenticator });
      authBridge.getOrCreateSession("sess-1");
      const cliSocket = createMockSocket();
      authBridge.handleCLIOpen(cliSocket, "sess-1");
      authBridge.handleCLIMessage("sess-1", makeInitMsg());

      // Connect participant
      const wsParticipant = createMockSocket();
      authBridge.handleConsumerOpen(wsParticipant, authContext("sess-1"));
      await new Promise((r) => setTimeout(r, 0));

      // Connect observer
      const wsObserver = createMockSocket();
      authBridge.handleConsumerOpen(wsObserver, authContext("sess-1"));
      await new Promise((r) => setTimeout(r, 0));

      // Add a pending permission
      authBridge.handleCLIMessage(
        "sess-1",
        JSON.stringify({
          type: "control_request",
          request_id: "perm-1",
          uuid: "u-perm",
          session_id: "cli-123",
          request: {
            subtype: "can_use_tool",
            tool_name: "Bash",
            input: { command: "ls" },
            permission_suggestions: [],
            description: "run ls",
            tool_use_id: "tu-1",
            agent_id: null,
          },
        }),
      );

      wsParticipant.sentMessages.length = 0;
      wsObserver.sentMessages.length = 0;

      // Disconnect CLI — should send permission_cancelled only to participant
      authBridge.handleCLIClose("sess-1");

      const participantMsgs = wsParticipant.sentMessages.map((m) => JSON.parse(m));
      const observerMsgs = wsObserver.sentMessages.map((m) => JSON.parse(m));

      // Participant gets cli_disconnected + permission_cancelled
      expect(participantMsgs.some((m: any) => m.type === "permission_cancelled")).toBe(true);
      // Observer gets cli_disconnected but NOT permission_cancelled
      expect(observerMsgs.some((m: any) => m.type === "cli_disconnected")).toBe(true);
      expect(observerMsgs.some((m: any) => m.type === "permission_cancelled")).toBe(false);
    });
  });

  // ── Slash command routing ────────────────────────────────────────────────

  describe("slash_command routing", () => {
    it("observers cannot send slash_command messages", () => {
      const authenticator: Authenticator = {
        async authenticate(): Promise<ConsumerIdentity> {
          return { userId: "obs-1", displayName: "Observer", role: "observer" };
        },
      };
      const { bridge } = createBridge({ authenticator });
      const cliSocket = createMockSocket();
      const ws = createMockSocket();

      bridge.handleCLIOpen(cliSocket, "sess-1");
      bridge.handleConsumerOpen(ws, authContext("sess-1"));

      // Wait for auth to complete
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          ws.sentMessages.length = 0;
          bridge.handleConsumerMessage(
            ws,
            "sess-1",
            JSON.stringify({ type: "slash_command", command: "/model" }),
          );
          const msgs = ws.sentMessages.map((m) => JSON.parse(m));
          expect(msgs.some((m: any) => m.type === "error")).toBe(true);
          resolve();
        }, 50);
      });
    });

    it("forwards native commands as user messages to CLI", () => {
      const { bridge } = createBridge();
      const cliSocket = createMockSocket();
      const ws = createMockSocket();

      bridge.handleCLIOpen(cliSocket, "sess-1");
      bridge.handleConsumerOpen(ws, authContext("sess-1"));
      bridge.handleCLIMessage("sess-1", makeInitMsg());

      ws.sentMessages.length = 0;
      cliSocket.sentMessages.length = 0;

      bridge.handleConsumerMessage(
        ws,
        "sess-1",
        JSON.stringify({ type: "slash_command", command: "/compact" }),
      );

      // CLI should receive a user message with the command text
      const cliMsgs = cliSocket.sentMessages.map((m) => JSON.parse(m));
      expect(cliMsgs.some((m: any) => m.type === "user" && m.message.content === "/compact")).toBe(
        true,
      );
    });

    it("emulates /model command and broadcasts result", async () => {
      const { bridge } = createBridge();
      const cliSocket = createMockSocket();
      const ws = createMockSocket();

      bridge.handleCLIOpen(cliSocket, "sess-1");
      bridge.handleConsumerOpen(ws, authContext("sess-1"));
      bridge.handleCLIMessage("sess-1", makeInitMsg({ model: "claude-opus-4-6" }));

      ws.sentMessages.length = 0;

      bridge.handleConsumerMessage(
        ws,
        "sess-1",
        JSON.stringify({ type: "slash_command", command: "/model", request_id: "req-1" }),
      );

      // Wait for async execution
      await new Promise((r) => setTimeout(r, 50));

      const msgs = ws.sentMessages.map((m) => JSON.parse(m));
      const result = msgs.find((m: any) => m.type === "slash_command_result");
      expect(result).toBeDefined();
      expect(result.command).toBe("/model");
      expect(result.request_id).toBe("req-1");
      expect(result.content).toBe("claude-opus-4-6");
      expect(result.source).toBe("emulated");
    });

    it("broadcasts error for unknown commands", async () => {
      const bridge = new SessionBridge({
        config: { port: 3456 },
        logger: noopLogger,
      });
      const cliSocket = createMockSocket();
      const ws = createMockSocket();

      bridge.handleCLIOpen(cliSocket, "sess-1");
      bridge.handleConsumerOpen(ws, authContext("sess-1"));
      bridge.handleCLIMessage("sess-1", makeInitMsg());

      ws.sentMessages.length = 0;

      bridge.handleConsumerMessage(
        ws,
        "sess-1",
        JSON.stringify({ type: "slash_command", command: "/nonexistent", request_id: "req-2" }),
      );

      // Wait for async execution
      await new Promise((r) => setTimeout(r, 50));

      const msgs = ws.sentMessages.map((m) => JSON.parse(m));
      const errorMsg = msgs.find((m: any) => m.type === "slash_command_error");
      expect(errorMsg).toBeDefined();
      expect(errorMsg.command).toBe("/nonexistent");
      expect(errorMsg.request_id).toBe("req-2");
      expect(errorMsg.error).toContain("Unknown slash command");
    });

    it("echoes request_id in results", async () => {
      const { bridge } = createBridge();
      const cliSocket = createMockSocket();
      const ws = createMockSocket();

      bridge.handleCLIOpen(cliSocket, "sess-1");
      bridge.handleConsumerOpen(ws, authContext("sess-1"));
      bridge.handleCLIMessage("sess-1", makeInitMsg());

      ws.sentMessages.length = 0;

      bridge.handleConsumerMessage(
        ws,
        "sess-1",
        JSON.stringify({ type: "slash_command", command: "/status", request_id: "my-req" }),
      );

      await new Promise((r) => setTimeout(r, 50));

      const msgs = ws.sentMessages.map((m) => JSON.parse(m));
      const result = msgs.find((m: any) => m.type === "slash_command_result");
      expect(result).toBeDefined();
      expect(result.request_id).toBe("my-req");
    });

    it("emits slash_command:executed event", async () => {
      const { bridge } = createBridge();
      const cliSocket = createMockSocket();
      const ws = createMockSocket();

      bridge.handleCLIOpen(cliSocket, "sess-1");
      bridge.handleConsumerOpen(ws, authContext("sess-1"));
      bridge.handleCLIMessage("sess-1", makeInitMsg());

      const events: any[] = [];
      bridge.on("slash_command:executed", (e) => events.push(e));

      bridge.handleConsumerMessage(
        ws,
        "sess-1",
        JSON.stringify({ type: "slash_command", command: "/model" }),
      );

      await new Promise((r) => setTimeout(r, 50));

      expect(events).toHaveLength(1);
      expect(events[0].sessionId).toBe("sess-1");
      expect(events[0].command).toBe("/model");
      expect(events[0].source).toBe("emulated");
    });

    it("stores cliSessionId from init message", () => {
      const { bridge } = createBridge();
      const cliSocket = createMockSocket();
      bridge.handleCLIOpen(cliSocket, "sess-1");
      bridge.handleCLIMessage("sess-1", makeInitMsg({ session_id: "cli-abc" }));

      // Verify via programmatic API — executeSlashCommand uses the stored cliSessionId
      const snapshot = bridge.getSession("sess-1");
      expect(snapshot).toBeDefined();
    });

    it("stores modelUsage from result messages", () => {
      const { bridge } = createBridge();
      const cliSocket = createMockSocket();
      bridge.handleCLIOpen(cliSocket, "sess-1");
      bridge.handleCLIMessage("sess-1", makeInitMsg());
      bridge.handleCLIMessage(
        "sess-1",
        makeResultMsg({
          modelUsage: {
            "claude-sonnet-4-5-20250929": {
              inputTokens: 1000,
              outputTokens: 500,
              cacheReadInputTokens: 200,
              cacheCreationInputTokens: 100,
              contextWindow: 200000,
              costUSD: 0.05,
            },
          },
          duration_ms: 3000,
          duration_api_ms: 2500,
        }),
      );

      const snapshot = bridge.getSession("sess-1");
      expect(snapshot?.state.last_model_usage).toBeDefined();
      expect(snapshot?.state.last_duration_ms).toBe(3000);
      expect(snapshot?.state.last_duration_api_ms).toBe(2500);
    });

    it("programmatic executeSlashCommand returns emulated result", async () => {
      const { bridge } = createBridge();
      const cliSocket = createMockSocket();
      bridge.handleCLIOpen(cliSocket, "sess-1");
      bridge.handleCLIMessage("sess-1", makeInitMsg({ model: "claude-opus-4-6" }));

      const result = await bridge.executeSlashCommand("sess-1", "/model");
      expect(result).toBeDefined();
      expect(result!.content).toBe("claude-opus-4-6");
      expect(result!.source).toBe("emulated");
    });

    it("programmatic executeSlashCommand returns null for unknown sessions", async () => {
      const { bridge } = createBridge();
      const result = await bridge.executeSlashCommand("nonexistent", "/model");
      expect(result).toBeNull();
    });

    it("programmatic executeSlashCommand forwards native commands", async () => {
      const { bridge } = createBridge();
      const cliSocket = createMockSocket();
      bridge.handleCLIOpen(cliSocket, "sess-1");
      bridge.handleCLIMessage("sess-1", makeInitMsg());

      cliSocket.sentMessages.length = 0;

      const result = await bridge.executeSlashCommand("sess-1", "/compact");
      expect(result).toBeNull(); // native commands return null
      // But the command was forwarded
      const cliMsgs = cliSocket.sentMessages.map((m) => JSON.parse(m));
      expect(cliMsgs.some((m: any) => m.type === "user")).toBe(true);
    });
  });

  // ── Initialize capabilities ──────────────────────────────────────────

  describe("Initialize capabilities", () => {
    function makeControlResponse(overrides: Record<string, unknown> = {}) {
      return JSON.stringify({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: "test-uuid",
          response: {
            commands: [
              { name: "/help", description: "Show help", argumentHint: "[topic]" },
              { name: "/compact", description: "Compact context" },
            ],
            models: [
              {
                value: "claude-sonnet-4-5-20250929",
                displayName: "Claude Sonnet 4.5",
                description: "Fast",
              },
              { value: "claude-opus-4-5-20250514", displayName: "Claude Opus 4.5" },
            ],
            account: {
              email: "user@example.com",
              organization: "Acme Corp",
              subscriptionType: "pro",
            },
          },
          ...overrides,
        },
      });
    }

    it("sends initialize request after system.init", () => {
      const cliSocket = createMockSocket();
      bridge.handleCLIOpen(cliSocket, "sess-1");
      bridge.handleCLIMessage("sess-1", makeInitMsg());

      // Should have sent session_init message + initialize control_request
      const sent = cliSocket.sentMessages.map((m) => JSON.parse(m));
      const initReq = sent.find(
        (m: any) => m.type === "control_request" && m.request?.subtype === "initialize",
      );
      expect(initReq).toBeDefined();
      expect(initReq.request_id).toBe("test-uuid");
    });

    it("handles successful control_response", () => {
      const cliSocket = createMockSocket();
      const consumerSocket = createMockSocket();
      bridge.handleCLIOpen(cliSocket, "sess-1");
      bridge.handleConsumerOpen(consumerSocket, authContext("sess-1"));
      bridge.handleCLIMessage("sess-1", makeInitMsg());

      consumerSocket.sentMessages.length = 0;

      const readyHandler = vi.fn();
      bridge.on("capabilities:ready", readyHandler);

      bridge.handleCLIMessage("sess-1", makeControlResponse());

      // State should be populated
      const snapshot = bridge.getSession("sess-1");
      expect(snapshot!.state.capabilities).toBeDefined();
      expect(snapshot!.state.capabilities!.commands).toHaveLength(2);
      expect(snapshot!.state.capabilities!.models).toHaveLength(2);
      expect(snapshot!.state.capabilities!.account).toEqual({
        email: "user@example.com",
        organization: "Acme Corp",
        subscriptionType: "pro",
      });

      // Consumer should receive capabilities_ready
      const consumerMsgs = consumerSocket.sentMessages.map((m) => JSON.parse(m));
      const capMsg = consumerMsgs.find((m: any) => m.type === "capabilities_ready");
      expect(capMsg).toBeDefined();
      expect(capMsg.commands).toHaveLength(2);
      expect(capMsg.models).toHaveLength(2);

      // Event should be emitted
      expect(readyHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: "sess-1",
          commands: expect.arrayContaining([expect.objectContaining({ name: "/help" })]),
          models: expect.arrayContaining([
            expect.objectContaining({ value: "claude-sonnet-4-5-20250929" }),
          ]),
          account: expect.objectContaining({ email: "user@example.com" }),
        }),
      );
    });

    it("handles error control_response without crashing", () => {
      const cliSocket = createMockSocket();
      bridge.handleCLIOpen(cliSocket, "sess-1");
      bridge.handleCLIMessage("sess-1", makeInitMsg());

      const errorResponse = JSON.stringify({
        type: "control_response",
        response: {
          subtype: "error",
          request_id: "test-uuid",
          error: "Not supported",
        },
      });

      // Should not throw
      expect(() => bridge.handleCLIMessage("sess-1", errorResponse)).not.toThrow();

      // Capabilities should remain undefined
      const snapshot = bridge.getSession("sess-1");
      expect(snapshot!.state.capabilities).toBeUndefined();
    });

    it("handles timeout gracefully", async () => {
      vi.useFakeTimers();
      const { bridge: timedBridge } = createBridge();

      const cliSocket = createMockSocket();
      timedBridge.handleCLIOpen(cliSocket, "sess-1");

      const timeoutHandler = vi.fn();
      timedBridge.on("capabilities:timeout", timeoutHandler);

      timedBridge.handleCLIMessage("sess-1", makeInitMsg());

      // Advance past the 5s timeout
      vi.advanceTimersByTime(5001);

      expect(timeoutHandler).toHaveBeenCalledWith({ sessionId: "sess-1" });

      // Bridge should continue working normally
      const snapshot = timedBridge.getSession("sess-1");
      expect(snapshot).toBeDefined();
      expect(snapshot!.state.capabilities).toBeUndefined();

      timedBridge.close();
      vi.useRealTimers();
    });

    it("late-joining consumer receives capabilities_ready", () => {
      const cliSocket = createMockSocket();
      bridge.handleCLIOpen(cliSocket, "sess-1");
      bridge.handleCLIMessage("sess-1", makeInitMsg());
      bridge.handleCLIMessage("sess-1", makeControlResponse());

      // Now a new consumer joins
      const lateConsumer = createMockSocket();
      bridge.handleConsumerOpen(lateConsumer, authContext("sess-1"));

      const consumerMsgs = lateConsumer.sentMessages.map((m) => JSON.parse(m));
      const capMsg = consumerMsgs.find((m: any) => m.type === "capabilities_ready");
      expect(capMsg).toBeDefined();
      expect(capMsg.commands).toHaveLength(2);
      expect(capMsg.models).toHaveLength(2);
      expect(capMsg.account).toEqual({
        email: "user@example.com",
        organization: "Acme Corp",
        subscriptionType: "pro",
      });
    });

    it("CLI disconnect cancels pending initialize timer", () => {
      vi.useFakeTimers();
      const { bridge: timedBridge } = createBridge();

      const cliSocket = createMockSocket();
      timedBridge.handleCLIOpen(cliSocket, "sess-1");

      const timeoutHandler = vi.fn();
      timedBridge.on("capabilities:timeout", timeoutHandler);

      timedBridge.handleCLIMessage("sess-1", makeInitMsg());

      // Disconnect before timeout
      timedBridge.handleCLIClose("sess-1");

      // Advance past the timeout — should NOT fire
      vi.advanceTimersByTime(10000);

      expect(timeoutHandler).not.toHaveBeenCalled();

      timedBridge.close();
      vi.useRealTimers();
    });

    it("no duplicate initialize requests if system.init fires twice", () => {
      const cliSocket = createMockSocket();
      bridge.handleCLIOpen(cliSocket, "sess-1");
      bridge.handleCLIMessage("sess-1", makeInitMsg());

      // Fire init again
      bridge.handleCLIMessage("sess-1", makeInitMsg());

      // Should NOT have sent another initialize request (dedup)
      const sent = cliSocket.sentMessages.map((m) => JSON.parse(m));
      const initReqs = sent.filter(
        (m: any) => m.type === "control_request" && m.request?.subtype === "initialize",
      );
      expect(initReqs).toHaveLength(1);
    });

    describe("accessor APIs with populated capabilities", () => {
      beforeEach(() => {
        const cliSocket = createMockSocket();
        bridge.handleCLIOpen(cliSocket, "sess-1");
        bridge.handleCLIMessage("sess-1", makeInitMsg());
        bridge.handleCLIMessage("sess-1", makeControlResponse());
      });

      it("getSupportedModels returns correct data", () => {
        const models = bridge.getSupportedModels("sess-1");
        expect(models).toHaveLength(2);
        expect(models[0]).toEqual({
          value: "claude-sonnet-4-5-20250929",
          displayName: "Claude Sonnet 4.5",
          description: "Fast",
        });
      });

      it("getSupportedCommands returns correct data", () => {
        const commands = bridge.getSupportedCommands("sess-1");
        expect(commands).toHaveLength(2);
        expect(commands[0]).toEqual({
          name: "/help",
          description: "Show help",
          argumentHint: "[topic]",
        });
      });

      it("getAccountInfo returns correct data", () => {
        const account = bridge.getAccountInfo("sess-1");
        expect(account).toEqual({
          email: "user@example.com",
          organization: "Acme Corp",
          subscriptionType: "pro",
        });
      });
    });

    it("getSupportedModels returns empty array when no capabilities", () => {
      bridge.getOrCreateSession("sess-1");
      expect(bridge.getSupportedModels("sess-1")).toEqual([]);
    });

    it("getSupportedCommands returns empty array when no capabilities", () => {
      bridge.getOrCreateSession("sess-1");
      expect(bridge.getSupportedCommands("sess-1")).toEqual([]);
    });

    it("getAccountInfo returns null when no capabilities", () => {
      bridge.getOrCreateSession("sess-1");
      expect(bridge.getAccountInfo("sess-1")).toBeNull();
    });

    it("returns empty/null for nonexistent sessions", () => {
      expect(bridge.getSupportedModels("nonexistent")).toEqual([]);
      expect(bridge.getSupportedCommands("nonexistent")).toEqual([]);
      expect(bridge.getAccountInfo("nonexistent")).toBeNull();
    });

    it("ignores control_response with unknown request_id", () => {
      const cliSocket = createMockSocket();
      bridge.handleCLIOpen(cliSocket, "sess-1");
      bridge.handleCLIMessage("sess-1", makeInitMsg());

      const readyHandler = vi.fn();
      bridge.on("capabilities:ready", readyHandler);

      const unknownResponse = JSON.stringify({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: "unknown-id",
          response: { commands: [], models: [] },
        },
      });

      bridge.handleCLIMessage("sess-1", unknownResponse);

      expect(readyHandler).not.toHaveBeenCalled();
      expect(bridge.getSession("sess-1")!.state.capabilities).toBeUndefined();
    });

    it("handles control_response with empty response gracefully", () => {
      const cliSocket = createMockSocket();
      bridge.handleCLIOpen(cliSocket, "sess-1");
      bridge.handleCLIMessage("sess-1", makeInitMsg());

      const emptyResponse = JSON.stringify({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: "test-uuid",
        },
      });

      expect(() => bridge.handleCLIMessage("sess-1", emptyResponse)).not.toThrow();
      expect(bridge.getSession("sess-1")!.state.capabilities).toBeUndefined();
    });

    it("closeSession cancels pending initialize timer", () => {
      vi.useFakeTimers();
      const { bridge: timedBridge } = createBridge();

      const cliSocket = createMockSocket();
      timedBridge.handleCLIOpen(cliSocket, "sess-1");

      const timeoutHandler = vi.fn();
      timedBridge.on("capabilities:timeout", timeoutHandler);

      timedBridge.handleCLIMessage("sess-1", makeInitMsg());

      timedBridge.closeSession("sess-1");

      vi.advanceTimersByTime(10000);

      expect(timeoutHandler).not.toHaveBeenCalled();

      vi.useRealTimers();
    });

    it("removeSession cancels pending initialize timer", () => {
      vi.useFakeTimers();
      const { bridge: timedBridge } = createBridge();

      const cliSocket = createMockSocket();
      timedBridge.handleCLIOpen(cliSocket, "sess-1");

      const timeoutHandler = vi.fn();
      timedBridge.on("capabilities:timeout", timeoutHandler);

      timedBridge.handleCLIMessage("sess-1", makeInitMsg());

      timedBridge.removeSession("sess-1");

      vi.advanceTimersByTime(10000);

      expect(timeoutHandler).not.toHaveBeenCalled();

      vi.useRealTimers();
    });

    it("handles partial capabilities (only commands, no models or account)", () => {
      const cliSocket = createMockSocket();
      bridge.handleCLIOpen(cliSocket, "sess-1");
      bridge.handleCLIMessage("sess-1", makeInitMsg());

      const partialResponse = JSON.stringify({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: "test-uuid",
          response: {
            commands: [{ name: "/help", description: "Help" }],
          },
        },
      });

      bridge.handleCLIMessage("sess-1", partialResponse);

      const snapshot = bridge.getSession("sess-1");
      expect(snapshot!.state.capabilities).toBeDefined();
      expect(snapshot!.state.capabilities!.commands).toHaveLength(1);
      expect(snapshot!.state.capabilities!.models).toEqual([]);
      expect(snapshot!.state.capabilities!.account).toBeNull();
    });
  });
});
