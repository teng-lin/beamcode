import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:crypto", () => ({ randomUUID: () => "test-uuid" }));

import { MemoryStorage } from "../adapters/memory-storage.js";
import type { WebSocketLike } from "../interfaces/transport.js";
import {
  createBridgeWithAdapter,
  type MockBackendAdapter,
  makeAssistantUnifiedMsg,
  makeAuthStatusUnifiedMsg,
  makeControlResponseUnifiedMsg,
  makePermissionRequestUnifiedMsg,
  makeResultUnifiedMsg,
  makeSessionInitMsg,
  makeStatusChangeMsg,
  makeStreamEventUnifiedMsg,
  makeToolProgressUnifiedMsg,
  makeToolUseSummaryUnifiedMsg,
  noopLogger,
  tick,
} from "../testing/adapter-test-helpers.js";
import { authContext } from "../testing/cli-message-factories.js";
import type {
  BackendAdapter,
  BackendCapabilities,
  BackendSession,
  ConnectOptions,
} from "./interfaces/backend-adapter.js";
import { SessionBridge } from "./session-bridge.js";
import type { UnifiedMessage } from "./types/unified-message.js";
import { createUnifiedMessage } from "./types/unified-message.js";

// ─── Test-local helpers (not in shared module) ──────────────────────────────

/**
 * A session whose async iterator rejects immediately — used for stream error tests.
 */
class ErrorBackendSession implements BackendSession {
  readonly sessionId: string;
  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }
  send(): void {}
  sendRaw(_ndjson: string): void {
    throw new Error("ErrorBackendSession does not support raw NDJSON");
  }
  get messages(): AsyncIterable<UnifiedMessage> {
    return {
      [Symbol.asyncIterator](): AsyncIterator<UnifiedMessage> {
        return {
          next: () => Promise.reject(new Error("Stream error")),
        };
      },
    };
  }
  async close(): Promise<void> {}
}

class ErrorBackendAdapter implements BackendAdapter {
  readonly name = "error-mock";
  readonly capabilities: BackendCapabilities = {
    streaming: true,
    permissions: true,
    slashCommands: false,
    availability: "local",
    teams: false,
  };
  async connect(options: ConnectOptions): Promise<BackendSession> {
    return new ErrorBackendSession(options.sessionId);
  }
}

class PassthroughBackendSession implements BackendSession {
  readonly sessionId: string;
  readonly sentMessages: UnifiedMessage[] = [];
  private passthroughHandler: ((rawMsg: any) => boolean) | null = null;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  send(message: UnifiedMessage): void {
    this.sentMessages.push(message);
  }

  sendRaw(): void {}

  get messages(): AsyncIterable<UnifiedMessage> {
    return {
      [Symbol.asyncIterator](): AsyncIterator<UnifiedMessage> {
        return {
          next: () => new Promise<IteratorResult<UnifiedMessage>>(() => {}),
        };
      },
    };
  }

  async close(): Promise<void> {}

  setPassthroughHandler(handler: ((rawMsg: any) => boolean) | null): void {
    this.passthroughHandler = handler;
  }

  emitUserEcho(content: unknown): void {
    this.passthroughHandler?.({
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
    });
  }
}

class PassthroughBackendAdapter implements BackendAdapter {
  readonly name = "passthrough-mock";
  readonly capabilities: BackendCapabilities = {
    streaming: true,
    permissions: true,
    slashCommands: true,
    availability: "local",
    teams: false,
  };

  private sessions = new Map<string, PassthroughBackendSession>();

  async connect(options: ConnectOptions): Promise<BackendSession> {
    const session = new PassthroughBackendSession(options.sessionId);
    this.sessions.set(options.sessionId, session);
    return session;
  }

  getSession(id: string): PassthroughBackendSession | undefined {
    return this.sessions.get(id);
  }
}

/**
 * A mock socket using vi.fn() so tests can mutate sentMessages.length = 0.
 * (The shared createMockSocket uses a getter-based approach that doesn't
 * support direct array mutation, which many tests here rely on.)
 */
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

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("SessionBridge (BackendAdapter path)", () => {
  let bridge: SessionBridge;
  let storage: MemoryStorage;
  let adapter: MockBackendAdapter;

  beforeEach(() => {
    const created = createBridgeWithAdapter();
    bridge = created.bridge;
    storage = created.storage;
    adapter = created.adapter;
  });

  // ── 1. hasAdapter ──────────────────────────────────────────────────────

  describe("hasAdapter", () => {
    it("returns true when adapter is configured", () => {
      expect(bridge.hasAdapter).toBe(true);
    });

    it("returns false when no adapter is configured", () => {
      const noBridge = new SessionBridge({ config: { port: 3456 }, logger: noopLogger });
      expect(noBridge.hasAdapter).toBe(false);
    });
  });

  // ── 2. connectBackend lifecycle ────────────────────────────────────────

  describe("connectBackend", () => {
    it("creates session and connects backend", async () => {
      await bridge.connectBackend("sess-1");

      expect(bridge.isBackendConnected("sess-1")).toBe(true);
      const snapshot = bridge.getSession("sess-1");
      expect(snapshot).toBeDefined();
    });

    it("emits backend:connected event", async () => {
      const backendHandler = vi.fn();
      bridge.on("backend:connected", backendHandler);

      await bridge.connectBackend("sess-1");

      expect(backendHandler).toHaveBeenCalledWith({ sessionId: "sess-1" });
    });

    it("broadcasts cli_connected to consumers", async () => {
      bridge.getOrCreateSession("sess-1");
      const consumer = createMockSocket();
      bridge.handleConsumerOpen(consumer, authContext("sess-1"));

      await bridge.connectBackend("sess-1");

      const msgs = consumer.sentMessages.map((s) => JSON.parse(s));
      const connected = msgs.find((m: { type: string }) => m.type === "cli_connected");
      expect(connected).toBeDefined();
    });

    it("throws when no adapter is configured", async () => {
      const plain = new SessionBridge({ config: { port: 3456 }, logger: noopLogger });
      await expect(plain.connectBackend("sess-1")).rejects.toThrow("No BackendAdapter configured");
    });

    it("connection failure propagates error", async () => {
      adapter.setShouldFail(true);
      await expect(bridge.connectBackend("sess-1")).rejects.toThrow("Connection failed");
    });

    it("replaces an existing backend session on reconnect", async () => {
      await bridge.connectBackend("sess-1");
      const firstSession = adapter.getSession("sess-1");

      await bridge.connectBackend("sess-1");
      expect(firstSession!.closed).toBe(true);
      expect(bridge.isBackendConnected("sess-1")).toBe(true);
    });

    it("converts passthrough user-echo into slash_command_result", async () => {
      const storage = new MemoryStorage();
      const passthroughAdapter = new PassthroughBackendAdapter();
      const passthroughBridge = new SessionBridge({
        storage,
        config: { port: 3456 },
        logger: noopLogger,
        adapter: passthroughAdapter,
      });
      const consumer = createMockSocket();

      await passthroughBridge.connectBackend("sess-p");
      const backendSession = passthroughAdapter.getSession("sess-p")!;
      passthroughBridge.handleConsumerOpen(consumer, authContext("sess-p"));
      consumer.sentMessages.length = 0;

      passthroughBridge.handleConsumerMessage(
        consumer,
        "sess-p",
        JSON.stringify({ type: "slash_command", command: "/context", request_id: "req-ctx" }),
      );

      expect(
        backendSession.sentMessages.some(
          (m) =>
            m.type === "user_message" &&
            m.content.some((b) => b.type === "text" && "text" in b && b.text === "/context"),
        ),
      ).toBe(true);

      backendSession.emitUserEcho("Context: 23% used");
      await tick();

      const msgs = consumer.sentMessages.map((s) => JSON.parse(s));
      const result = msgs.find((m: { type: string }) => m.type === "slash_command_result");
      expect(result).toBeDefined();
      expect(result.command).toBe("/context");
      expect(result.request_id).toBe("req-ctx");
      expect(result.source).toBe("cli");
      expect(result.content).toContain("Context");
    });
  });

  // ── 3. disconnectBackend ───────────────────────────────────────────────

  describe("disconnectBackend", () => {
    it("disconnects backend and emits backend:disconnected event", async () => {
      await bridge.connectBackend("sess-1");

      const backendHandler = vi.fn();
      bridge.on("backend:disconnected", backendHandler);

      await bridge.disconnectBackend("sess-1");

      expect(bridge.isBackendConnected("sess-1")).toBe(false);
      expect(backendHandler).toHaveBeenCalledWith({
        sessionId: "sess-1",
        code: 1000,
        reason: "normal",
      });
    });

    it("broadcasts cli_disconnected to consumers", async () => {
      bridge.getOrCreateSession("sess-1");
      const consumer = createMockSocket();
      bridge.handleConsumerOpen(consumer, authContext("sess-1"));

      await bridge.connectBackend("sess-1");
      consumer.sentMessages.length = 0;

      await bridge.disconnectBackend("sess-1");

      const msgs = consumer.sentMessages.map((s) => JSON.parse(s));
      expect(msgs.some((m: { type: string }) => m.type === "cli_disconnected")).toBe(true);
    });

    it("cancels pending permissions on disconnect", async () => {
      bridge.getOrCreateSession("sess-1");
      const consumer = createMockSocket();
      bridge.handleConsumerOpen(consumer, authContext("sess-1"));
      await bridge.connectBackend("sess-1");

      const backendSession = adapter.getSession("sess-1")!;
      backendSession.pushMessage(makePermissionRequestUnifiedMsg());
      await tick();

      consumer.sentMessages.length = 0;
      await bridge.disconnectBackend("sess-1");

      const msgs = consumer.sentMessages.map((s) => JSON.parse(s));
      const cancelled = msgs.find((m: { type: string }) => m.type === "permission_cancelled");
      expect(cancelled).toBeDefined();
      expect(cancelled.request_id).toBe("perm-req-1");
    });

    it("is safe for nonexistent sessions", async () => {
      await expect(bridge.disconnectBackend("nonexistent")).resolves.toBeUndefined();
    });
  });

  // ── 4. sendToBackend ───────────────────────────────────────────────────

  describe("sendToBackend", () => {
    it("sends a UnifiedMessage to the backend session", async () => {
      await bridge.connectBackend("sess-1");
      const backendSession = adapter.getSession("sess-1")!;

      const msg = createUnifiedMessage({
        type: "user_message",
        role: "user",
        content: [{ type: "text", text: "hello" }],
      });
      bridge.sendToBackend("sess-1", msg);

      expect(backendSession.sentMessages).toHaveLength(1);
      expect(backendSession.sentMessages[0].type).toBe("user_message");
    });

    it("warns when no backend session exists", async () => {
      const msg = createUnifiedMessage({ type: "user_message", role: "user" });
      // Should not throw
      bridge.sendToBackend("nonexistent", msg);
    });

    it("emits error when send throws", async () => {
      await bridge.connectBackend("sess-1");
      const backendSession = adapter.getSession("sess-1")!;

      // Make send throw without closing (closing would null the session reference)
      const origSend = backendSession.send.bind(backendSession);
      backendSession.send = () => {
        throw new Error("Send failed");
      };

      const errorHandler = vi.fn();
      bridge.on("error", errorHandler);

      const msg = createUnifiedMessage({ type: "user_message", role: "user" });
      bridge.sendToBackend("sess-1", msg);

      expect(errorHandler).toHaveBeenCalledWith(
        expect.objectContaining({ source: "sendToBackend" }),
      );

      // Restore
      backendSession.send = origSend;
    });
  });

  // ── 5. Message routing (backend → consumers) ──────────────────────────

  describe("message routing: session_init", () => {
    it("broadcasts session_init to consumers and updates state", async () => {
      bridge.getOrCreateSession("sess-1");
      const consumer = createMockSocket();
      bridge.handleConsumerOpen(consumer, authContext("sess-1"));
      await bridge.connectBackend("sess-1");

      consumer.sentMessages.length = 0;
      const backendSession = adapter.getSession("sess-1")!;
      backendSession.pushMessage(makeSessionInitMsg());
      await tick();

      const msgs = consumer.sentMessages.map((s) => JSON.parse(s));
      const init = msgs.find((m: { type: string }) => m.type === "session_init");
      expect(init).toBeDefined();
      expect(init.session.model).toBe("claude-sonnet-4-5-20250929");
      expect(init.session.cwd).toBe("/test");
      expect(init.session.tools).toEqual(["Bash", "Read"]);
    });

    it("emits backend:session_id event", async () => {
      const backendHandler = vi.fn();
      bridge.on("backend:session_id", backendHandler);

      await bridge.connectBackend("sess-1");
      const backendSession = adapter.getSession("sess-1")!;
      backendSession.pushMessage(makeSessionInitMsg());
      await tick();

      expect(backendHandler).toHaveBeenCalledWith({
        sessionId: "sess-1",
        backendSessionId: "backend-123",
      });
    });

    it("persists session on session_init", async () => {
      await bridge.connectBackend("sess-1");
      const backendSession = adapter.getSession("sess-1")!;
      backendSession.pushMessage(makeSessionInitMsg());
      await tick();

      const saved = storage.loadAll();
      expect(saved.some((s) => s.id === "sess-1")).toBe(true);
    });
  });

  describe("message routing: status_change", () => {
    it("broadcasts status_change to consumers", async () => {
      bridge.getOrCreateSession("sess-1");
      const consumer = createMockSocket();
      bridge.handleConsumerOpen(consumer, authContext("sess-1"));
      await bridge.connectBackend("sess-1");

      consumer.sentMessages.length = 0;
      const backendSession = adapter.getSession("sess-1")!;
      backendSession.pushMessage(makeStatusChangeMsg({ status: "running" }));
      await tick();

      const msgs = consumer.sentMessages.map((s) => JSON.parse(s));
      const status = msgs.find((m: { type: string }) => m.type === "status_change");
      expect(status).toBeDefined();
      expect(status.status).toBe("running");
    });

    it("updates is_compacting in session state", async () => {
      await bridge.connectBackend("sess-1");
      const backendSession = adapter.getSession("sess-1")!;
      backendSession.pushMessage(makeStatusChangeMsg({ status: "compacting" }));
      await tick();

      const snapshot = bridge.getSession("sess-1");
      expect(snapshot!.state.is_compacting).toBe(true);
    });
  });

  describe("message routing: assistant", () => {
    it("broadcasts assistant message to consumers", async () => {
      bridge.getOrCreateSession("sess-1");
      const consumer = createMockSocket();
      bridge.handleConsumerOpen(consumer, authContext("sess-1"));
      await bridge.connectBackend("sess-1");

      consumer.sentMessages.length = 0;
      const backendSession = adapter.getSession("sess-1")!;
      backendSession.pushMessage(makeAssistantUnifiedMsg());
      await tick();

      const msgs = consumer.sentMessages.map((s) => JSON.parse(s));
      const assistantMsg = msgs.find((m: { type: string }) => m.type === "assistant");
      expect(assistantMsg).toBeDefined();
      expect(assistantMsg.message.role).toBe("assistant");
      expect(assistantMsg.message.model).toBe("claude-sonnet-4-5-20250929");
      expect(assistantMsg.message.content).toEqual([{ type: "text", text: "Hello world" }]);
      expect(assistantMsg.parent_tool_use_id).toBeNull();
    });

    it("stores assistant message in history", async () => {
      await bridge.connectBackend("sess-1");
      const backendSession = adapter.getSession("sess-1")!;
      backendSession.pushMessage(makeAssistantUnifiedMsg());
      await tick();

      const snapshot = bridge.getSession("sess-1");
      expect(snapshot!.messageHistoryLength).toBe(1);
    });

    it("maps tool_use content blocks correctly", async () => {
      bridge.getOrCreateSession("sess-1");
      const consumer = createMockSocket();
      bridge.handleConsumerOpen(consumer, authContext("sess-1"));
      await bridge.connectBackend("sess-1");

      consumer.sentMessages.length = 0;
      const backendSession = adapter.getSession("sess-1")!;
      backendSession.pushMessage(
        createUnifiedMessage({
          type: "assistant",
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tu-1",
              name: "Bash",
              input: { command: "ls" },
            },
          ],
          metadata: {
            message_id: "msg-2",
            model: "claude-sonnet-4-5-20250929",
            stop_reason: "tool_use",
            parent_tool_use_id: null,
            usage: {
              input_tokens: 5,
              output_tokens: 10,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
            },
          },
        }),
      );
      await tick();

      const msgs = consumer.sentMessages.map((s) => JSON.parse(s));
      const assistantMsg = msgs.find((m: { type: string }) => m.type === "assistant");
      expect(assistantMsg).toBeDefined();
      expect(assistantMsg.message.content[0]).toEqual({
        type: "tool_use",
        id: "tu-1",
        name: "Bash",
        input: { command: "ls" },
      });
    });
  });

  describe("message routing: result", () => {
    it("broadcasts result to consumers with correct fields", async () => {
      bridge.getOrCreateSession("sess-1");
      const consumer = createMockSocket();
      bridge.handleConsumerOpen(consumer, authContext("sess-1"));
      await bridge.connectBackend("sess-1");

      consumer.sentMessages.length = 0;
      const backendSession = adapter.getSession("sess-1")!;
      backendSession.pushMessage(makeResultUnifiedMsg());
      await tick();

      const msgs = consumer.sentMessages.map((s) => JSON.parse(s));
      const result = msgs.find((m: { type: string }) => m.type === "result");
      expect(result).toBeDefined();
      expect(result.data.subtype).toBe("success");
      expect(result.data.is_error).toBe(false);
      expect(result.data.result).toBe("Done");
      expect(result.data.duration_ms).toBe(1000);
      expect(result.data.total_cost_usd).toBe(0.01);
      expect(result.data.num_turns).toBe(1);
    });

    it("updates session state with cost and turns", async () => {
      await bridge.connectBackend("sess-1");
      const backendSession = adapter.getSession("sess-1")!;
      backendSession.pushMessage(makeResultUnifiedMsg({ total_cost_usd: 0.05, num_turns: 3 }));
      await tick();

      const snapshot = bridge.getSession("sess-1");
      expect(snapshot!.state.total_cost_usd).toBe(0.05);
      expect(snapshot!.state.num_turns).toBe(3);
    });

    it("emits session:first_turn_completed on first successful turn", async () => {
      const handler = vi.fn();
      bridge.on("session:first_turn_completed", handler);

      bridge.getOrCreateSession("sess-1");
      const consumer = createMockSocket();
      bridge.handleConsumerOpen(consumer, authContext("sess-1"));

      await bridge.connectBackend("sess-1");
      const backendSession = adapter.getSession("sess-1")!;

      // Send user message to history first (via consumer path)
      bridge.handleConsumerMessage(
        consumer,
        "sess-1",
        JSON.stringify({
          type: "user_message",
          content: "Hello Claude",
        }),
      );

      backendSession.pushMessage(makeResultUnifiedMsg({ num_turns: 1, is_error: false }));
      await tick();

      expect(handler).toHaveBeenCalledWith({
        sessionId: "sess-1",
        firstUserMessage: "Hello Claude",
      });
    });

    it("does not emit session:first_turn_completed on error", async () => {
      const handler = vi.fn();
      bridge.on("session:first_turn_completed", handler);

      await bridge.connectBackend("sess-1");
      const backendSession = adapter.getSession("sess-1")!;
      backendSession.pushMessage(makeResultUnifiedMsg({ num_turns: 1, is_error: true }));
      await tick();

      expect(handler).not.toHaveBeenCalled();
    });

    it("computes context_used_percent from modelUsage", async () => {
      await bridge.connectBackend("sess-1");
      const backendSession = adapter.getSession("sess-1")!;
      backendSession.pushMessage(
        makeResultUnifiedMsg({
          modelUsage: {
            "claude-sonnet-4-5-20250929": {
              inputTokens: 4000,
              outputTokens: 1000,
              cacheReadInputTokens: 0,
              cacheCreationInputTokens: 0,
              contextWindow: 10000,
              maxOutputTokens: 8096,
              costUSD: 0.01,
            },
          },
        }),
      );
      await tick();

      const snapshot = bridge.getSession("sess-1");
      expect(snapshot!.state.context_used_percent).toBe(50);
    });
  });

  describe("message routing: stream_event", () => {
    it("broadcasts stream_event to consumers", async () => {
      bridge.getOrCreateSession("sess-1");
      const consumer = createMockSocket();
      bridge.handleConsumerOpen(consumer, authContext("sess-1"));
      await bridge.connectBackend("sess-1");

      consumer.sentMessages.length = 0;
      const backendSession = adapter.getSession("sess-1")!;
      backendSession.pushMessage(makeStreamEventUnifiedMsg());
      await tick();

      const msgs = consumer.sentMessages.map((s) => JSON.parse(s));
      const event = msgs.find((m: { type: string }) => m.type === "stream_event");
      expect(event).toBeDefined();
      expect(event.event.type).toBe("content_block_delta");
      expect(event.parent_tool_use_id).toBeNull();
    });
  });

  describe("message routing: permission_request", () => {
    it("stores permission and broadcasts to consumers", async () => {
      bridge.getOrCreateSession("sess-1");
      const consumer = createMockSocket();
      bridge.handleConsumerOpen(consumer, authContext("sess-1"));
      await bridge.connectBackend("sess-1");

      consumer.sentMessages.length = 0;
      const backendSession = adapter.getSession("sess-1")!;
      backendSession.pushMessage(makePermissionRequestUnifiedMsg());
      await tick();

      const msgs = consumer.sentMessages.map((s) => JSON.parse(s));
      const permMsg = msgs.find((m: { type: string }) => m.type === "permission_request");
      expect(permMsg).toBeDefined();
      expect(permMsg.request.request_id).toBe("perm-req-1");
      expect(permMsg.request.tool_name).toBe("Bash");
      expect(permMsg.request.input).toEqual({ command: "ls" });
    });

    it("emits permission:requested event", async () => {
      const handler = vi.fn();
      bridge.on("permission:requested", handler);

      await bridge.connectBackend("sess-1");
      const backendSession = adapter.getSession("sess-1")!;
      backendSession.pushMessage(makePermissionRequestUnifiedMsg());
      await tick();

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

    it("tracks permission in session snapshot", async () => {
      await bridge.connectBackend("sess-1");
      const backendSession = adapter.getSession("sess-1")!;
      backendSession.pushMessage(makePermissionRequestUnifiedMsg());
      await tick();

      const snapshot = bridge.getSession("sess-1");
      expect(snapshot!.pendingPermissions).toHaveLength(1);
      expect(snapshot!.pendingPermissions[0].request_id).toBe("perm-req-1");
    });
  });

  describe("message routing: tool_progress", () => {
    it("broadcasts tool_progress to consumers", async () => {
      bridge.getOrCreateSession("sess-1");
      const consumer = createMockSocket();
      bridge.handleConsumerOpen(consumer, authContext("sess-1"));
      await bridge.connectBackend("sess-1");

      consumer.sentMessages.length = 0;
      const backendSession = adapter.getSession("sess-1")!;
      backendSession.pushMessage(makeToolProgressUnifiedMsg());
      await tick();

      const msgs = consumer.sentMessages.map((s) => JSON.parse(s));
      const progress = msgs.find((m: { type: string }) => m.type === "tool_progress");
      expect(progress).toBeDefined();
      expect(progress.tool_use_id).toBe("tu-1");
      expect(progress.tool_name).toBe("Bash");
      expect(progress.elapsed_time_seconds).toBe(5);
    });
  });

  describe("message routing: tool_use_summary", () => {
    it("broadcasts tool_use_summary to consumers", async () => {
      bridge.getOrCreateSession("sess-1");
      const consumer = createMockSocket();
      bridge.handleConsumerOpen(consumer, authContext("sess-1"));
      await bridge.connectBackend("sess-1");

      consumer.sentMessages.length = 0;
      const backendSession = adapter.getSession("sess-1")!;
      backendSession.pushMessage(makeToolUseSummaryUnifiedMsg());
      await tick();

      const msgs = consumer.sentMessages.map((s) => JSON.parse(s));
      const summary = msgs.find((m: { type: string }) => m.type === "tool_use_summary");
      expect(summary).toBeDefined();
      expect(summary.summary).toBe("Ran bash command");
      expect(summary.tool_use_ids).toEqual(["tu-1", "tu-2"]);
    });
  });

  describe("message routing: auth_status", () => {
    it("broadcasts auth_status to consumers and emits event", async () => {
      const authHandler = vi.fn();
      bridge.on("auth_status", authHandler);

      bridge.getOrCreateSession("sess-1");
      const consumer = createMockSocket();
      bridge.handleConsumerOpen(consumer, authContext("sess-1"));
      await bridge.connectBackend("sess-1");

      consumer.sentMessages.length = 0;
      const backendSession = adapter.getSession("sess-1")!;
      backendSession.pushMessage(makeAuthStatusUnifiedMsg());
      await tick();

      const msgs = consumer.sentMessages.map((s) => JSON.parse(s));
      const authMsg = msgs.find((m: { type: string }) => m.type === "auth_status");
      expect(authMsg).toBeDefined();
      expect(authMsg.isAuthenticating).toBe(true);
      expect(authMsg.output).toEqual(["Authenticating..."]);

      expect(authHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: "sess-1",
          isAuthenticating: true,
        }),
      );
    });
  });

  // ── 6. Initialize capabilities protocol ────────────────────────────────

  describe("initialize capabilities (via adapter path)", () => {
    it("sends initialize request after session_init", async () => {
      await bridge.connectBackend("sess-1");
      const backendSession = adapter.getSession("sess-1")!;

      backendSession.pushMessage(makeSessionInitMsg());
      await tick();

      // sendInitializeRequest sends via backendSession.sendRaw when connected.
      // Verify pendingInitialize is set indirectly: the session should exist.
      const snapshot = bridge.getSession("sess-1");
      expect(snapshot).toBeDefined();
    });

    it("handles control_response for capabilities", async () => {
      const capHandler = vi.fn();
      bridge.on("capabilities:ready", capHandler);

      await bridge.connectBackend("sess-1");
      const backendSession = adapter.getSession("sess-1")!;

      backendSession.pushMessage(makeSessionInitMsg());
      await tick();

      backendSession.pushMessage(makeControlResponseUnifiedMsg());
      await tick();

      expect(capHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: "sess-1",
          commands: [{ name: "/help", description: "Get help" }],
          models: [{ value: "claude-sonnet-4-5-20250929", displayName: "Claude Sonnet 4.5" }],
          account: { email: "test@example.com" },
        }),
      );
    });

    it("broadcasts capabilities_ready to consumers", async () => {
      bridge.getOrCreateSession("sess-1");
      const consumer = createMockSocket();
      bridge.handleConsumerOpen(consumer, authContext("sess-1"));
      await bridge.connectBackend("sess-1");
      consumer.sentMessages.length = 0;

      const backendSession = adapter.getSession("sess-1")!;
      backendSession.pushMessage(makeSessionInitMsg());
      await tick();
      backendSession.pushMessage(makeControlResponseUnifiedMsg());
      await tick();

      const msgs = consumer.sentMessages.map((s) => JSON.parse(s));
      const capMsg = msgs.find((m: { type: string }) => m.type === "capabilities_ready");
      expect(capMsg).toBeDefined();
      expect(capMsg.commands).toHaveLength(1);
      expect(capMsg.models).toHaveLength(1);
    });

    it("ignores control_response with unknown request_id", async () => {
      const capHandler = vi.fn();
      bridge.on("capabilities:ready", capHandler);

      await bridge.connectBackend("sess-1");
      const backendSession = adapter.getSession("sess-1")!;

      backendSession.pushMessage(makeSessionInitMsg());
      await tick();

      backendSession.pushMessage(makeControlResponseUnifiedMsg({ request_id: "wrong-id" }));
      await tick();

      expect(capHandler).not.toHaveBeenCalled();
    });
  });

  // ── 7. Backend stream termination ──────────────────────────────────────

  describe("backend stream termination", () => {
    it("emits backend:disconnected when stream ends naturally", async () => {
      const backendHandler = vi.fn();
      bridge.on("backend:disconnected", backendHandler);

      await bridge.connectBackend("sess-1");
      const backendSession = adapter.getSession("sess-1")!;

      backendSession.channel.close();
      await tick();

      expect(backendHandler).toHaveBeenCalledWith({
        sessionId: "sess-1",
        code: 1000,
        reason: "stream ended",
      });
    });

    it("broadcasts cli_disconnected when stream ends", async () => {
      bridge.getOrCreateSession("sess-1");
      const consumer = createMockSocket();
      bridge.handleConsumerOpen(consumer, authContext("sess-1"));
      await bridge.connectBackend("sess-1");

      consumer.sentMessages.length = 0;
      const backendSession = adapter.getSession("sess-1")!;
      backendSession.channel.close();
      await tick();

      const msgs = consumer.sentMessages.map((s) => JSON.parse(s));
      expect(msgs.some((m: { type: string }) => m.type === "cli_disconnected")).toBe(true);
    });

    it("cancels pending permissions when stream ends", async () => {
      bridge.getOrCreateSession("sess-1");
      const consumer = createMockSocket();
      bridge.handleConsumerOpen(consumer, authContext("sess-1"));
      await bridge.connectBackend("sess-1");

      const backendSession = adapter.getSession("sess-1")!;
      backendSession.pushMessage(makePermissionRequestUnifiedMsg());
      await tick();

      consumer.sentMessages.length = 0;
      backendSession.channel.close();
      await tick();

      const msgs = consumer.sentMessages.map((s) => JSON.parse(s));
      const cancelled = msgs.find((m: { type: string }) => m.type === "permission_cancelled");
      expect(cancelled).toBeDefined();
    });

    it("emits error on stream error", async () => {
      // Use a separate bridge with an error-producing adapter
      const errorAdapter = new ErrorBackendAdapter();
      const { bridge: errorBridge } = createBridgeWithAdapter({ adapter: errorAdapter });

      const errorHandler = vi.fn();
      errorBridge.on("error", errorHandler);

      await errorBridge.connectBackend("sess-1");
      await tick(50);

      expect(errorHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          source: "backendConsumption",
          sessionId: "sess-1",
        }),
      );
    });
  });

  // ── 8. closeSession with backend ───────────────────────────────────────

  describe("closeSession with backend", () => {
    it("closes backend session and cleans up", async () => {
      await bridge.connectBackend("sess-1");
      const backendSession = adapter.getSession("sess-1")!;

      const closedHandler = vi.fn();
      bridge.on("session:closed", closedHandler);

      bridge.closeSession("sess-1");

      expect(backendSession.closed).toBe(true);
      expect(bridge.getSession("sess-1")).toBeUndefined();
      expect(closedHandler).toHaveBeenCalledWith({ sessionId: "sess-1" });
    });
  });

  // ── 9. Multiple consumers receive the same broadcasts ──────────────────

  describe("multi-consumer broadcast", () => {
    it("all consumers receive backend messages", async () => {
      bridge.getOrCreateSession("sess-1");
      const c1 = createMockSocket();
      const c2 = createMockSocket();
      bridge.handleConsumerOpen(c1, authContext("sess-1"));
      bridge.handleConsumerOpen(c2, authContext("sess-1"));

      await bridge.connectBackend("sess-1");
      c1.sentMessages.length = 0;
      c2.sentMessages.length = 0;

      const backendSession = adapter.getSession("sess-1")!;
      backendSession.pushMessage(makeAssistantUnifiedMsg());
      await tick();

      const c1Msgs = c1.sentMessages.map((s) => JSON.parse(s));
      const c2Msgs = c2.sentMessages.map((s) => JSON.parse(s));
      expect(c1Msgs.some((m: { type: string }) => m.type === "assistant")).toBe(true);
      expect(c2Msgs.some((m: { type: string }) => m.type === "assistant")).toBe(true);
    });
  });

  // ── 10. State reduction via adapter path ───────────────────────────────

  describe("state reduction via adapter path", () => {
    it("reduces session_init into session state", async () => {
      await bridge.connectBackend("sess-1");
      const backendSession = adapter.getSession("sess-1")!;
      backendSession.pushMessage(
        makeSessionInitMsg({
          model: "claude-opus-4-6",
          cwd: "/home/user",
        }),
      );
      await tick();

      const snapshot = bridge.getSession("sess-1");
      expect(snapshot!.state.model).toBe("claude-opus-4-6");
      expect(snapshot!.state.cwd).toBe("/home/user");
    });

    it("reduces result into session state", async () => {
      await bridge.connectBackend("sess-1");
      const backendSession = adapter.getSession("sess-1")!;
      backendSession.pushMessage(
        makeResultUnifiedMsg({
          total_cost_usd: 0.15,
          num_turns: 5,
          total_lines_added: 42,
          total_lines_removed: 10,
        }),
      );
      await tick();

      const snapshot = bridge.getSession("sess-1");
      expect(snapshot!.state.total_cost_usd).toBe(0.15);
      expect(snapshot!.state.num_turns).toBe(5);
      expect(snapshot!.state.total_lines_added).toBe(42);
      expect(snapshot!.state.total_lines_removed).toBe(10);
    });

    it("reduces status_change into session state", async () => {
      await bridge.connectBackend("sess-1");
      const backendSession = adapter.getSession("sess-1")!;

      backendSession.pushMessage(makeStatusChangeMsg({ status: "compacting" }));
      await tick();
      expect(bridge.getSession("sess-1")!.state.is_compacting).toBe(true);

      backendSession.pushMessage(makeStatusChangeMsg({ status: null }));
      await tick();
      expect(bridge.getSession("sess-1")!.state.is_compacting).toBe(false);
    });
  });

  // ── 11. Outbound event emission ────────────────────────────────────────

  describe("message:outbound event emission", () => {
    it("emits message:outbound for every broadcast", async () => {
      const handler = vi.fn();
      bridge.on("message:outbound", handler);

      bridge.getOrCreateSession("sess-1");
      const consumer = createMockSocket();
      bridge.handleConsumerOpen(consumer, authContext("sess-1"));
      await bridge.connectBackend("sess-1");

      handler.mockClear();
      const backendSession = adapter.getSession("sess-1")!;
      backendSession.pushMessage(makeAssistantUnifiedMsg());
      await tick();

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: "sess-1",
          message: expect.objectContaining({ type: "assistant" }),
        }),
      );
    });
  });

  // ── 12. Persistence via adapter path ───────────────────────────────────

  describe("persistence via adapter path", () => {
    it("persists on session_init", async () => {
      await bridge.connectBackend("sess-1");
      adapter.getSession("sess-1")!.pushMessage(makeSessionInitMsg());
      await tick();

      const saved = storage.loadAll();
      expect(saved.some((s) => s.id === "sess-1")).toBe(true);
    });

    it("persists on assistant message", async () => {
      await bridge.connectBackend("sess-1");
      adapter.getSession("sess-1")!.pushMessage(makeAssistantUnifiedMsg());
      await tick();

      const saved = storage.loadAll();
      expect(saved.some((s) => s.id === "sess-1")).toBe(true);
    });

    it("persists on result message", async () => {
      await bridge.connectBackend("sess-1");
      adapter.getSession("sess-1")!.pushMessage(makeResultUnifiedMsg());
      await tick();

      const saved = storage.loadAll();
      expect(saved.some((s) => s.id === "sess-1")).toBe(true);
    });

    it("persists on permission_request", async () => {
      await bridge.connectBackend("sess-1");
      adapter.getSession("sess-1")!.pushMessage(makePermissionRequestUnifiedMsg());
      await tick();

      const saved = storage.loadAll();
      expect(saved.some((s) => s.id === "sess-1")).toBe(true);
    });
  });

  // ── 13. Multiple adapter sessions ──────────────────────────────────────

  describe("multiple adapter sessions", () => {
    it("supports separate sessions via adapter", async () => {
      await bridge.connectBackend("sess-a");
      await bridge.connectBackend("sess-b");

      expect(bridge.isBackendConnected("sess-a")).toBe(true);
      expect(bridge.isBackendConnected("sess-b")).toBe(true);
      expect(bridge.isCliConnected("sess-a")).toBe(true);
      expect(bridge.isCliConnected("sess-b")).toBe(true);
    });
  });

  // ── 14. Pending message flush ──────────────────────────────────────────

  describe("pending message flush on connect", () => {
    it("flushes pending messages via backendSession.send when adapter active", async () => {
      bridge.getOrCreateSession("sess-1");
      bridge.sendUserMessage("sess-1", "hello");

      await bridge.connectBackend("sess-1");
      // connectBackend flushes pendingMessages via backendSession.send()
      const session = adapter.getSession("sess-1")!;
      expect(session.sentMessages.length).toBeGreaterThan(0);
      expect(session.sentMessages[0].type).toBe("user_message");
    });
  });

  // ── 15. Programmatic API dual-path ──────────────────────────────────────

  describe("programmatic API dual-path", () => {
    describe("sendUserMessage", () => {
      it("routes through backendSession.send() when adapter active", async () => {
        await bridge.connectBackend("sess-1");
        const backendSession = adapter.getSession("sess-1")!;

        bridge.sendUserMessage("sess-1", "Hello via adapter");

        // backendSession.send() should have been called with a UnifiedMessage
        expect(backendSession.sentMessages).toHaveLength(1);
        const msg = backendSession.sentMessages[0];
        expect(msg.type).toBe("user_message");
        expect(msg.role).toBe("user");
        const textBlock = msg.content.find((b) => b.type === "text");
        expect(textBlock).toBeDefined();
        expect(textBlock!.type === "text" && textBlock!.text).toBe("Hello via adapter");
      });

      it("routes exclusively through backendSession (no legacy path)", async () => {
        await bridge.connectBackend("sess-1");
        const backendSession = adapter.getSession("sess-1")!;

        bridge.sendUserMessage("sess-1", "Hello via adapter");

        expect(backendSession.sentMessages).toHaveLength(1);
        expect(backendSession.sentMessages[0].type).toBe("user_message");
      });

      it("preserves message history and broadcast when adapter active", async () => {
        bridge.getOrCreateSession("sess-1");
        const consumer = createMockSocket();
        bridge.handleConsumerOpen(consumer, authContext("sess-1"));
        await bridge.connectBackend("sess-1");
        consumer.sentMessages.length = 0;

        bridge.sendUserMessage("sess-1", "History test");

        const snapshot = bridge.getSession("sess-1")!;
        expect(snapshot.messageHistoryLength).toBe(1);

        // Consumer should receive user_message broadcast
        const msgs = consumer.sentMessages.map((s) => JSON.parse(s));
        const userMsg = msgs.find((m: { type: string }) => m.type === "user_message");
        expect(userMsg).toBeDefined();
        expect(userMsg.content).toBe("History test");
      });

      it("includes session_id override in unified message metadata", async () => {
        await bridge.connectBackend("sess-1");
        const backendSession = adapter.getSession("sess-1")!;

        bridge.sendUserMessage("sess-1", "Hello", { sessionIdOverride: "override-id" });

        const msg = backendSession.sentMessages[0];
        expect(msg.metadata.session_id).toBe("override-id");
      });

      it("includes images in unified message content when adapter active", async () => {
        await bridge.connectBackend("sess-1");
        const backendSession = adapter.getSession("sess-1")!;

        bridge.sendUserMessage("sess-1", "Describe this", {
          images: [{ media_type: "image/png", data: "base64data" }],
        });

        const msg = backendSession.sentMessages[0];
        const imageBlocks = msg.content.filter((b) => b.type === "image");
        const textBlocks = msg.content.filter((b) => b.type === "text");
        expect(imageBlocks).toHaveLength(1);
        expect(textBlocks).toHaveLength(1);
      });

      it("persists session when adapter active", async () => {
        await bridge.connectBackend("sess-1");

        bridge.sendUserMessage("sess-1", "Persist test");

        const saved = storage.loadAll();
        expect(saved.some((s) => s.id === "sess-1")).toBe(true);
      });
    });

    describe("sendPermissionResponse", () => {
      it("routes through backendSession.send() when adapter active", async () => {
        await bridge.connectBackend("sess-1");
        const backendSession = adapter.getSession("sess-1")!;

        // Register pending permission via adapter path
        backendSession.pushMessage(makePermissionRequestUnifiedMsg());
        await tick();

        bridge.sendPermissionResponse("sess-1", "perm-req-1", "allow");

        expect(backendSession.sentMessages).toHaveLength(1);
        const msg = backendSession.sentMessages[0];
        expect(msg.type).toBe("permission_response");
        expect(msg.metadata.request_id).toBe("perm-req-1");
        expect(msg.metadata.behavior).toBe("allow");
      });

      it("routes deny through backendSession.send() when adapter active", async () => {
        await bridge.connectBackend("sess-1");
        const backendSession = adapter.getSession("sess-1")!;

        backendSession.pushMessage(makePermissionRequestUnifiedMsg());
        await tick();

        bridge.sendPermissionResponse("sess-1", "perm-req-1", "deny", { message: "No thanks" });

        expect(backendSession.sentMessages).toHaveLength(1);
        const msg = backendSession.sentMessages[0];
        expect(msg.type).toBe("permission_response");
        expect(msg.metadata.behavior).toBe("deny");
        expect(msg.metadata.message).toBe("No thanks");
      });

      it("still emits permission:resolved event when adapter active", async () => {
        await bridge.connectBackend("sess-1");
        const backendSession = adapter.getSession("sess-1")!;

        backendSession.pushMessage(makePermissionRequestUnifiedMsg());
        await tick();

        const resolvedHandler = vi.fn();
        bridge.on("permission:resolved", resolvedHandler);

        bridge.sendPermissionResponse("sess-1", "perm-req-1", "allow");

        expect(resolvedHandler).toHaveBeenCalledWith({
          sessionId: "sess-1",
          requestId: "perm-req-1",
          behavior: "allow",
        });
      });

      it("still validates unknown request_id when adapter active", async () => {
        await bridge.connectBackend("sess-1");
        const backendSession = adapter.getSession("sess-1")!;

        // No pending permissions registered, so "unknown-req" should be no-op
        bridge.sendPermissionResponse("sess-1", "unknown-req", "allow");

        expect(backendSession.sentMessages).toHaveLength(0);
      });
    });

    describe("sendControlRequest (interrupt, set_model, set_permission_mode)", () => {
      it("routes interrupt through backendSession.send() when adapter active", async () => {
        await bridge.connectBackend("sess-1");
        const backendSession = adapter.getSession("sess-1")!;

        bridge.sendInterrupt("sess-1");

        expect(backendSession.sentMessages).toHaveLength(1);
        const msg = backendSession.sentMessages[0];
        expect(msg.type).toBe("interrupt");
        expect(msg.role).toBe("user");
      });

      it("routes set_model through backendSession.send() when adapter active", async () => {
        await bridge.connectBackend("sess-1");
        const backendSession = adapter.getSession("sess-1")!;

        bridge.sendSetModel("sess-1", "claude-opus-4-20250514");

        expect(backendSession.sentMessages).toHaveLength(1);
        const msg = backendSession.sentMessages[0];
        expect(msg.type).toBe("configuration_change");
        expect(msg.metadata.subtype).toBe("set_model");
        expect(msg.metadata.model).toBe("claude-opus-4-20250514");
      });

      it("routes set_permission_mode through backendSession.send() when adapter active", async () => {
        await bridge.connectBackend("sess-1");
        const backendSession = adapter.getSession("sess-1")!;

        bridge.sendSetPermissionMode("sess-1", "plan");

        expect(backendSession.sentMessages).toHaveLength(1);
        const msg = backendSession.sentMessages[0];
        expect(msg.type).toBe("configuration_change");
        expect(msg.metadata.subtype).toBe("set_permission_mode");
        expect(msg.metadata.mode).toBe("plan");
      });

      it("routes interrupt exclusively through backendSession", async () => {
        await bridge.connectBackend("sess-1");
        const backendSession = adapter.getSession("sess-1")!;

        bridge.sendInterrupt("sess-1");

        expect(backendSession.sentMessages).toHaveLength(1);
        expect(backendSession.sentMessages[0].type).toBe("interrupt");
      });
    });
  });

  // ── 16. CapabilitiesProtocol dual-path ──────────────────────────────────

  describe("CapabilitiesProtocol dual-path", () => {
    it("uses backendSession.sendRaw() for initialize when adapter active", async () => {
      await bridge.connectBackend("sess-1");
      const backendSession = adapter.getSession("sess-1")!;

      // Trigger session_init which calls capabilitiesProtocol.sendInitializeRequest()
      backendSession.pushMessage(makeSessionInitMsg());
      await tick();

      // sendRaw should have been called with the initialize request
      expect(backendSession.sentRawMessages.length).toBeGreaterThan(0);
      const initRaw = backendSession.sentRawMessages.find((raw) => {
        const parsed = JSON.parse(raw);
        return parsed.type === "control_request" && parsed.request?.subtype === "initialize";
      });
      expect(initRaw).toBeDefined();
      const parsed = JSON.parse(initRaw!);
      expect(parsed.request.subtype).toBe("initialize");
      expect(parsed.request_id).toBeTypeOf("string");
    });
  });
});
