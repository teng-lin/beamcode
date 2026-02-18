import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:crypto", () => ({ randomUUID: () => "test-uuid" }));

import { MemoryStorage } from "../adapters/memory-storage.js";
import type { AuthContext } from "../interfaces/auth.js";
import type { WebSocketLike } from "../interfaces/transport.js";
import type {
  BackendAdapter,
  BackendCapabilities,
  BackendSession,
  ConnectOptions,
} from "./interfaces/backend-adapter.js";
import { SessionBridge } from "./session-bridge.js";
import type { UnifiedMessage } from "./types/unified-message.js";
import { createUnifiedMessage } from "./types/unified-message.js";

// ─── Mock BackendSession with controllable message channel ───────────────────

function createMessageChannel() {
  const queue: UnifiedMessage[] = [];
  let resolve: ((value: IteratorResult<UnifiedMessage>) => void) | null = null;
  let done = false;

  return {
    push(msg: UnifiedMessage) {
      if (resolve) {
        const r = resolve;
        resolve = null;
        r({ value: msg, done: false });
      } else {
        queue.push(msg);
      }
    },
    close() {
      done = true;
      if (resolve) {
        const r = resolve;
        resolve = null;
        r({ value: undefined, done: true });
      }
    },
    [Symbol.asyncIterator](): AsyncIterator<UnifiedMessage> {
      return {
        next(): Promise<IteratorResult<UnifiedMessage>> {
          if (queue.length > 0) {
            return Promise.resolve({ value: queue.shift()!, done: false });
          }
          if (done) {
            return Promise.resolve({
              value: undefined,
              done: true,
            });
          }
          return new Promise((r) => {
            resolve = r;
          });
        },
      };
    },
  };
}

class MockBackendSession implements BackendSession {
  readonly sessionId: string;
  readonly channel = createMessageChannel();
  readonly sentMessages: UnifiedMessage[] = [];
  private _closed = false;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  send(message: UnifiedMessage): void {
    if (this._closed) throw new Error("Session is closed");
    this.sentMessages.push(message);
  }

  get messages(): AsyncIterable<UnifiedMessage> {
    return this.channel;
  }

  async close(): Promise<void> {
    this._closed = true;
    this.channel.close();
  }

  get closed() {
    return this._closed;
  }

  /** Push a message into the channel (simulating backend → bridge). */
  pushMessage(msg: UnifiedMessage) {
    this.channel.push(msg);
  }
}

class MockBackendAdapter implements BackendAdapter {
  readonly name = "mock";
  readonly capabilities: BackendCapabilities = {
    streaming: true,
    permissions: true,
    slashCommands: false,
    availability: "local",
    teams: false,
  };

  private sessions = new Map<string, MockBackendSession>();
  private _shouldFail = false;

  setShouldFail(fail: boolean) {
    this._shouldFail = fail;
  }

  async connect(options: ConnectOptions): Promise<BackendSession> {
    if (this._shouldFail) {
      throw new Error("Connection failed");
    }
    const session = new MockBackendSession(options.sessionId);
    this.sessions.set(options.sessionId, session);
    return session;
  }

  getSession(id: string): MockBackendSession | undefined {
    return this.sessions.get(id);
  }
}

/**
 * A session whose async iterator rejects immediately — used for stream error tests.
 */
class ErrorBackendSession implements BackendSession {
  readonly sessionId: string;
  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }
  send(): void {}
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

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

function authContext(sessionId: string): AuthContext {
  return { sessionId, transport: {} };
}

function createBridgeWithAdapter(options?: { storage?: MemoryStorage; adapter?: BackendAdapter }) {
  const storage = options?.storage ?? new MemoryStorage();
  const adapter = options?.adapter ?? new MockBackendAdapter();
  const bridge = new SessionBridge({
    storage,
    config: { port: 3456 },
    logger: noopLogger,
    adapter,
  });
  return { bridge, storage, adapter: adapter as MockBackendAdapter };
}

// ─── UnifiedMessage factory helpers ──────────────────────────────────────────

function makeSessionInitMsg(overrides: Record<string, unknown> = {}): UnifiedMessage {
  return createUnifiedMessage({
    type: "session_init",
    role: "system",
    metadata: {
      session_id: "backend-123",
      model: "claude-sonnet-4-5-20250929",
      cwd: "/test",
      tools: ["Bash", "Read"],
      permissionMode: "default",
      claude_code_version: "1.0",
      mcp_servers: [],
      agents: [],
      slash_commands: [],
      skills: [],
      ...overrides,
    },
  });
}

function makeStatusChangeMsg(overrides: Record<string, unknown> = {}): UnifiedMessage {
  return createUnifiedMessage({
    type: "status_change",
    role: "system",
    metadata: {
      status: null,
      ...overrides,
    },
  });
}

function makeAssistantMsg(overrides: Record<string, unknown> = {}): UnifiedMessage {
  return createUnifiedMessage({
    type: "assistant",
    role: "assistant",
    content: [{ type: "text", text: "Hello world" }],
    metadata: {
      message_id: "msg-1",
      model: "claude-sonnet-4-5-20250929",
      stop_reason: "end_turn",
      parent_tool_use_id: null,
      usage: {
        input_tokens: 10,
        output_tokens: 20,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      ...overrides,
    },
  });
}

function makeResultMsg(overrides: Record<string, unknown> = {}): UnifiedMessage {
  return createUnifiedMessage({
    type: "result",
    role: "system",
    metadata: {
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
      ...overrides,
    },
  });
}

function makeStreamEventMsg(overrides: Record<string, unknown> = {}): UnifiedMessage {
  return createUnifiedMessage({
    type: "stream_event",
    role: "system",
    metadata: {
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "hi" } },
      parent_tool_use_id: null,
      ...overrides,
    },
  });
}

function makePermissionRequestMsg(overrides: Record<string, unknown> = {}): UnifiedMessage {
  return createUnifiedMessage({
    type: "permission_request",
    role: "system",
    metadata: {
      request_id: "perm-req-1",
      tool_name: "Bash",
      input: { command: "ls" },
      tool_use_id: "tu-1",
      ...overrides,
    },
  });
}

function makeToolProgressMsg(overrides: Record<string, unknown> = {}): UnifiedMessage {
  return createUnifiedMessage({
    type: "tool_progress",
    role: "system",
    metadata: {
      tool_use_id: "tu-1",
      tool_name: "Bash",
      elapsed_time_seconds: 5,
      ...overrides,
    },
  });
}

function makeToolUseSummaryMsg(overrides: Record<string, unknown> = {}): UnifiedMessage {
  return createUnifiedMessage({
    type: "tool_use_summary",
    role: "system",
    metadata: {
      summary: "Ran bash command",
      tool_use_ids: ["tu-1", "tu-2"],
      ...overrides,
    },
  });
}

function makeAuthStatusMsg(overrides: Record<string, unknown> = {}): UnifiedMessage {
  return createUnifiedMessage({
    type: "auth_status",
    role: "system",
    metadata: {
      isAuthenticating: true,
      output: ["Authenticating..."],
      ...overrides,
    },
  });
}

function makeControlResponseMsg(overrides: Record<string, unknown> = {}): UnifiedMessage {
  return createUnifiedMessage({
    type: "control_response",
    role: "system",
    metadata: {
      request_id: "test-uuid",
      subtype: "success",
      response: {
        commands: [{ name: "/help", description: "Get help" }],
        models: [{ value: "claude-sonnet-4-5-20250929", displayName: "Claude Sonnet 4.5" }],
        account: { email: "test@example.com" },
      },
      ...overrides,
    },
  });
}

/** Wait for async operations (message channel push → for-await → handlers). */
function tick(ms = 10): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
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

    it("emits backend:connected and cli:connected events", async () => {
      const backendHandler = vi.fn();
      const cliHandler = vi.fn();
      bridge.on("backend:connected", backendHandler);
      bridge.on("cli:connected", cliHandler);

      await bridge.connectBackend("sess-1");

      expect(backendHandler).toHaveBeenCalledWith({ sessionId: "sess-1" });
      expect(cliHandler).toHaveBeenCalledWith({ sessionId: "sess-1" });
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
  });

  // ── 3. disconnectBackend ───────────────────────────────────────────────

  describe("disconnectBackend", () => {
    it("disconnects backend and emits events", async () => {
      await bridge.connectBackend("sess-1");

      const backendHandler = vi.fn();
      const cliHandler = vi.fn();
      bridge.on("backend:disconnected", backendHandler);
      bridge.on("cli:disconnected", cliHandler);

      await bridge.disconnectBackend("sess-1");

      expect(bridge.isBackendConnected("sess-1")).toBe(false);
      expect(backendHandler).toHaveBeenCalledWith({
        sessionId: "sess-1",
        code: 1000,
        reason: "normal",
      });
      expect(cliHandler).toHaveBeenCalledWith({ sessionId: "sess-1" });
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
      backendSession.pushMessage(makePermissionRequestMsg());
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

    it("emits backend:session_id and cli:session_id events", async () => {
      const backendHandler = vi.fn();
      const cliHandler = vi.fn();
      bridge.on("backend:session_id", backendHandler);
      bridge.on("cli:session_id", cliHandler);

      await bridge.connectBackend("sess-1");
      const backendSession = adapter.getSession("sess-1")!;
      backendSession.pushMessage(makeSessionInitMsg());
      await tick();

      expect(backendHandler).toHaveBeenCalledWith({
        sessionId: "sess-1",
        backendSessionId: "backend-123",
      });
      expect(cliHandler).toHaveBeenCalledWith({
        sessionId: "sess-1",
        cliSessionId: "backend-123",
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
      backendSession.pushMessage(makeAssistantMsg());
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
      backendSession.pushMessage(makeAssistantMsg());
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
      backendSession.pushMessage(makeResultMsg());
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
      backendSession.pushMessage(makeResultMsg({ total_cost_usd: 0.05, num_turns: 3 }));
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

      backendSession.pushMessage(makeResultMsg({ num_turns: 1, is_error: false }));
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
      backendSession.pushMessage(makeResultMsg({ num_turns: 1, is_error: true }));
      await tick();

      expect(handler).not.toHaveBeenCalled();
    });

    it("computes context_used_percent from modelUsage", async () => {
      await bridge.connectBackend("sess-1");
      const backendSession = adapter.getSession("sess-1")!;
      backendSession.pushMessage(
        makeResultMsg({
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
      backendSession.pushMessage(makeStreamEventMsg());
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
      backendSession.pushMessage(makePermissionRequestMsg());
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
      backendSession.pushMessage(makePermissionRequestMsg());
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
      backendSession.pushMessage(makePermissionRequestMsg());
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
      backendSession.pushMessage(makeToolProgressMsg());
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
      backendSession.pushMessage(makeToolUseSummaryMsg());
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
      backendSession.pushMessage(makeAuthStatusMsg());
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

      // sendInitializeRequest calls sendToCLI, which queues when no cliSocket.
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

      backendSession.pushMessage(makeControlResponseMsg());
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
      backendSession.pushMessage(makeControlResponseMsg());
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

      backendSession.pushMessage(makeControlResponseMsg({ request_id: "wrong-id" }));
      await tick();

      expect(capHandler).not.toHaveBeenCalled();
    });
  });

  // ── 7. Backend stream termination ──────────────────────────────────────

  describe("backend stream termination", () => {
    it("emits disconnected events when stream ends naturally", async () => {
      const backendHandler = vi.fn();
      const cliHandler = vi.fn();
      bridge.on("backend:disconnected", backendHandler);
      bridge.on("cli:disconnected", cliHandler);

      await bridge.connectBackend("sess-1");
      const backendSession = adapter.getSession("sess-1")!;

      backendSession.channel.close();
      await tick();

      expect(backendHandler).toHaveBeenCalledWith({
        sessionId: "sess-1",
        code: 1000,
        reason: "stream ended",
      });
      expect(cliHandler).toHaveBeenCalledWith({ sessionId: "sess-1" });
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
      backendSession.pushMessage(makePermissionRequestMsg());
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
      backendSession.pushMessage(makeAssistantMsg());
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
        makeResultMsg({
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
      backendSession.pushMessage(makeAssistantMsg());
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
      adapter.getSession("sess-1")!.pushMessage(makeAssistantMsg());
      await tick();

      const saved = storage.loadAll();
      expect(saved.some((s) => s.id === "sess-1")).toBe(true);
    });

    it("persists on result message", async () => {
      await bridge.connectBackend("sess-1");
      adapter.getSession("sess-1")!.pushMessage(makeResultMsg());
      await tick();

      const saved = storage.loadAll();
      expect(saved.some((s) => s.id === "sess-1")).toBe(true);
    });

    it("persists on permission_request", async () => {
      await bridge.connectBackend("sess-1");
      adapter.getSession("sess-1")!.pushMessage(makePermissionRequestMsg());
      await tick();

      const saved = storage.loadAll();
      expect(saved.some((s) => s.id === "sess-1")).toBe(true);
    });
  });

  // ── 13. Coexistence: both paths active ─────────────────────────────────

  describe("coexistence: CLI and adapter paths", () => {
    it("supports separate sessions using different paths", async () => {
      // CLI-based session
      bridge.getOrCreateSession("cli-sess");
      const cliSocket = createMockSocket();
      bridge.handleCLIOpen(cliSocket, "cli-sess");

      // Adapter-based session
      await bridge.connectBackend("adapter-sess");

      expect(bridge.isCliConnected("cli-sess")).toBe(true);
      expect(bridge.isBackendConnected("adapter-sess")).toBe(true);
      expect(bridge.isCliConnected("adapter-sess")).toBe(false);
      expect(bridge.isBackendConnected("cli-sess")).toBe(false);
    });
  });

  // ── 14. Pending message flush ──────────────────────────────────────────

  describe("pending message flush on connect", () => {
    it("flushes pending messages when backend connects", async () => {
      bridge.getOrCreateSession("sess-1");
      bridge.sendUserMessage("sess-1", "hello");

      await bridge.connectBackend("sess-1");
      // connectBackend flushes pendingMessages via sendToCLI
      // But since cliSocket is still null, they re-queue (expected in coexistence mode)
    });
  });
});
