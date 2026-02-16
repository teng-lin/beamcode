import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type WebSocket from "ws";
import { createUnifiedMessage } from "../../core/types/unified-message.js";
import type { ProcessHandle, ProcessManager } from "../../interfaces/process-manager.js";
import { CodexAdapter } from "./codex-adapter.js";
import { CodexLauncher } from "./codex-launcher.js";
import { CodexSession } from "./codex-session.js";

// ---------------------------------------------------------------------------
// Mock WebSocket
// ---------------------------------------------------------------------------

class MockWebSocket extends EventEmitter {
  static readonly OPEN = 1;
  readyState = MockWebSocket.OPEN;
  sent: string[] = [];

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3; // CLOSED
    this.emit("close");
  }

  removeListener(event: string, listener: (...args: any[]) => void): this {
    return super.removeListener(event, listener);
  }
}

// ---------------------------------------------------------------------------
// Mock `ws` module for CodexAdapter.connect() tests.
// The factory returns a constructor fn whose behavior is set per-test.
// ---------------------------------------------------------------------------

const mockWsConstructor = vi.hoisted(() => {
  const fn = vi.fn();
  // Preserve the WebSocket constants used by CodexSession
  fn.OPEN = 1;
  fn.CLOSED = 3;
  fn.CONNECTING = 0;
  fn.CLOSING = 2;
  return fn;
});

vi.mock("ws", () => ({
  default: mockWsConstructor,
  __esModule: true,
}));

// ---------------------------------------------------------------------------
// Mock ProcessManager
// ---------------------------------------------------------------------------

function createMockProcessManager(): ProcessManager {
  const exitPromise = new Promise<number | null>(() => {});
  return {
    spawn: vi.fn().mockReturnValue({
      pid: 12345,
      exited: exitPromise,
      kill: vi.fn(),
      stdout: null,
      stderr: null,
    } satisfies ProcessHandle),
    isAlive: vi.fn().mockReturnValue(true),
  };
}

// ---------------------------------------------------------------------------
// CodexSession tests
// ---------------------------------------------------------------------------

describe("CodexSession", () => {
  let ws: MockWebSocket;
  let session: CodexSession;
  let launcher: CodexLauncher;

  beforeEach(() => {
    ws = new MockWebSocket();
    launcher = new CodexLauncher({
      processManager: createMockProcessManager(),
    });
    session = new CodexSession({
      sessionId: "test-session",
      ws: ws as unknown as WebSocket,
      launcher,
    });
  });

  afterEach(() => {
    ws.close();
  });

  describe("send", () => {
    it("sends turn.create JSON-RPC for user_message", () => {
      const msg = createUnifiedMessage({
        type: "user_message",
        role: "user",
        content: [{ type: "text", text: "Hello" }],
      });

      session.send(msg);

      expect(ws.sent).toHaveLength(1);
      const parsed = JSON.parse(ws.sent[0]);
      expect(parsed.jsonrpc).toBe("2.0");
      expect(parsed.method).toBe("turn.create");
      expect(parsed.params.input).toBe("Hello");
      expect(parsed.id).toBe(1);
    });

    it("sends approval.respond for permission_response (allow)", () => {
      const msg = createUnifiedMessage({
        type: "permission_response",
        role: "user",
        metadata: { behavior: "allow", request_id: "req-1" },
      });

      session.send(msg);

      const parsed = JSON.parse(ws.sent[0]);
      expect(parsed.method).toBe("approval.respond");
      expect(parsed.params.approve).toBe(true);
      expect(parsed.params.item_id).toBe("req-1");
    });

    it("sends approval.respond for permission_response (deny)", () => {
      const msg = createUnifiedMessage({
        type: "permission_response",
        role: "user",
        metadata: { behavior: "deny", request_id: "req-2" },
      });

      session.send(msg);

      const parsed = JSON.parse(ws.sent[0]);
      expect(parsed.method).toBe("approval.respond");
      expect(parsed.params.approve).toBe(false);
    });

    it("sends turn.cancel notification for interrupt", () => {
      const msg = createUnifiedMessage({
        type: "interrupt",
        role: "user",
      });

      session.send(msg);

      const parsed = JSON.parse(ws.sent[0]);
      expect(parsed.jsonrpc).toBe("2.0");
      expect(parsed.method).toBe("turn.cancel");
      expect(parsed.id).toBeUndefined();
    });

    it("increments JSON-RPC id for sequential requests", () => {
      const msg1 = createUnifiedMessage({
        type: "user_message",
        role: "user",
        content: [{ type: "text", text: "first" }],
      });
      const msg2 = createUnifiedMessage({
        type: "user_message",
        role: "user",
        content: [{ type: "text", text: "second" }],
      });

      session.send(msg1);
      session.send(msg2);

      expect(JSON.parse(ws.sent[0]).id).toBe(1);
      expect(JSON.parse(ws.sent[1]).id).toBe(2);
    });

    it("throws on send after close", async () => {
      await session.close();

      expect(() =>
        session.send(
          createUnifiedMessage({
            type: "user_message",
            role: "user",
            content: [{ type: "text", text: "ignored" }],
          }),
        ),
      ).toThrow("Session is closed");
    });
  });

  describe("messages (async iterable)", () => {
    it("yields translated UnifiedMessage for text delta notifications", async () => {
      const notification = JSON.stringify({
        jsonrpc: "2.0",
        method: "response.output_text.delta",
        params: { delta: "Hello world", output_index: 0 },
      });

      // Start iterating
      const iter = session.messages[Symbol.asyncIterator]();
      const nextPromise = iter.next();

      // Simulate incoming message
      ws.emit("message", Buffer.from(notification));

      const result = await nextPromise;
      expect(result.done).toBe(false);
      expect(result.value.type).toBe("stream_event");
      expect(result.value.role).toBe("assistant");
      expect(result.value.metadata.delta).toBe("Hello world");
    });

    it("yields translated approval_requested as permission_request", async () => {
      const notification = JSON.stringify({
        jsonrpc: "2.0",
        method: "approval_requested",
        params: {
          type: "approval_requested",
          item: {
            type: "function_call",
            id: "fc-1",
            name: "shell",
            arguments: '{"command":"ls"}',
            call_id: "call-1",
          },
        },
      });

      const iter = session.messages[Symbol.asyncIterator]();
      const nextPromise = iter.next();

      ws.emit("message", Buffer.from(notification));

      const result = await nextPromise;
      expect(result.done).toBe(false);
      expect(result.value.type).toBe("permission_request");
      expect(result.value.metadata.tool_name).toBe("shell");
    });

    it("queues messages when no consumer is waiting", async () => {
      // Send two messages before anyone reads
      ws.emit(
        "message",
        Buffer.from(
          JSON.stringify({
            jsonrpc: "2.0",
            method: "response.output_text.delta",
            params: { delta: "first", output_index: 0 },
          }),
        ),
      );
      ws.emit(
        "message",
        Buffer.from(
          JSON.stringify({
            jsonrpc: "2.0",
            method: "response.output_text.delta",
            params: { delta: "second", output_index: 0 },
          }),
        ),
      );

      const iter = session.messages[Symbol.asyncIterator]();
      const r1 = await iter.next();
      const r2 = await iter.next();

      expect(r1.value.metadata.delta).toBe("first");
      expect(r2.value.metadata.delta).toBe("second");
    });

    it("signals done when WebSocket closes", async () => {
      const iter = session.messages[Symbol.asyncIterator]();
      const nextPromise = iter.next();

      ws.emit("close");

      const result = await nextPromise;
      expect(result.done).toBe(true);
    });

    it("ignores malformed JSON messages", async () => {
      const iter = session.messages[Symbol.asyncIterator]();

      // Send malformed JSON — should not throw
      ws.emit("message", Buffer.from("not json"));

      // Send valid message after
      ws.emit(
        "message",
        Buffer.from(
          JSON.stringify({
            jsonrpc: "2.0",
            method: "response.output_text.delta",
            params: { delta: "valid", output_index: 0 },
          }),
        ),
      );

      const result = await iter.next();
      expect(result.value.metadata.delta).toBe("valid");
    });
  });

  describe("close", () => {
    it("closes WebSocket and kills launcher process", async () => {
      const killSpy = vi.spyOn(launcher, "killProcess").mockResolvedValue(true);

      await session.close();

      expect(ws.readyState).toBe(3); // CLOSED
      expect(killSpy).toHaveBeenCalledWith("test-session");
    });

    it("is idempotent", async () => {
      const killSpy = vi.spyOn(launcher, "killProcess").mockResolvedValue(true);

      await session.close();
      await session.close();

      // killProcess should only be called once
      expect(killSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("init response", () => {
    it("enqueues session_init message when initResponse provided", async () => {
      const sessionWithInit = new CodexSession({
        sessionId: "init-session",
        ws: ws as unknown as WebSocket,
        launcher,
        initResponse: {
          capabilities: { streaming: true },
          version: "1.0.0",
        },
      });

      const iter = sessionWithInit.messages[Symbol.asyncIterator]();
      const result = await iter.next();

      expect(result.value.type).toBe("session_init");
      expect(result.value.metadata.capabilities).toEqual({ streaming: true });
      expect(result.value.metadata.version).toBe("1.0.0");
    });
  });
});

// ---------------------------------------------------------------------------
// CodexLauncher tests
// ---------------------------------------------------------------------------

describe("CodexLauncher", () => {
  it("spawns codex app-server with correct args", async () => {
    const pm = createMockProcessManager();
    const launcher = new CodexLauncher({ processManager: pm });

    const result = await launcher.launch("sess-1", { port: 9999 });

    expect(pm.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "codex",
        args: ["app-server", "--listen", "ws://127.0.0.1:9999"],
      }),
    );
    expect(result.url).toBe("ws://127.0.0.1:9999");
    expect(result.pid).toBe(12345);
  });

  it("uses default port when none specified", async () => {
    const pm = createMockProcessManager();
    const launcher = new CodexLauncher({ processManager: pm });

    const result = await launcher.launch("sess-2");

    expect(result.url).toBe("ws://127.0.0.1:19836");
  });

  it("uses custom binary when specified", async () => {
    const pm = createMockProcessManager();
    const launcher = new CodexLauncher({ processManager: pm });

    await launcher.launch("sess-3", { codexBinary: "/usr/local/bin/codex-cli" });

    expect(pm.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "/usr/local/bin/codex-cli",
      }),
    );
  });

  it("throws when spawn fails", async () => {
    const pm = createMockProcessManager();
    (pm.spawn as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("spawn failed");
    });
    const launcher = new CodexLauncher({ processManager: pm });

    // ProcessSupervisor emits 'error' events — add listener to prevent
    // Node's "unhandled error" from masking the actual throw.
    launcher.on("error", () => {});

    await expect(launcher.launch("sess-4")).rejects.toThrow("Failed to spawn");
  });
});

// ---------------------------------------------------------------------------
// CodexAdapter tests
// ---------------------------------------------------------------------------

describe("CodexAdapter", () => {
  it("has correct name and capabilities", () => {
    const adapter = new CodexAdapter({
      processManager: createMockProcessManager(),
    });
    expect(adapter.name).toBe("codex");
    expect(adapter.capabilities).toEqual({
      streaming: true,
      permissions: true,
      slashCommands: false,
      availability: "local",
      teams: false,
    });
  });

  describe("connect", () => {
    let adapter: CodexAdapter;
    let launchSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      adapter = new CodexAdapter({
        processManager: createMockProcessManager(),
      });
      // Mock CodexLauncher.prototype.launch to avoid real process spawning
      launchSpy = vi
        .spyOn(CodexLauncher.prototype, "launch")
        .mockResolvedValue({ url: "ws://127.0.0.1:9999", pid: 12345 });
    });

    afterEach(() => {
      launchSpy.mockRestore();
      mockWsConstructor.mockReset();
    });

    it("returns a CodexSession on successful connect and handshake", async () => {
      const mockWs = new MockWebSocket();

      // When CodexAdapter does `new WebSocket(url)`, return our mock
      mockWsConstructor.mockImplementation(() => {
        queueMicrotask(() => mockWs.emit("open"));
        return mockWs;
      });

      // Intercept send to respond to the initialize handshake
      const origSend = mockWs.send.bind(mockWs);
      mockWs.send = vi.fn((data: string) => {
        origSend(data);
        const parsed = JSON.parse(data);
        if (parsed.method === "initialize") {
          queueMicrotask(() => {
            mockWs.emit(
              "message",
              Buffer.from(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: parsed.id,
                  result: { capabilities: { streaming: true }, version: "1.0.0" },
                }),
              ),
            );
          });
        }
      });

      const session = await adapter.connect({ sessionId: "test-codex-session" });

      expect(session).toBeInstanceOf(CodexSession);
      expect(launchSpy).toHaveBeenCalledWith("test-codex-session", expect.any(Object));

      // Verify the initialized notification was sent after handshake
      const sentMessages = mockWs.sent.map((s) => JSON.parse(s));
      expect(sentMessages.some((m: any) => m.method === "initialized")).toBe(true);
    });

    it("rejects when WebSocket emits error during connection", async () => {
      const mockWs = new MockWebSocket();

      mockWsConstructor.mockImplementation(() => {
        queueMicrotask(() => mockWs.emit("error", new Error("Connection refused")));
        return mockWs;
      });

      await expect(adapter.connect({ sessionId: "err-session" })).rejects.toThrow(
        "Failed to connect to codex app-server",
      );
    });

    it("rejects when handshake returns an error response", async () => {
      const mockWs = new MockWebSocket();

      mockWsConstructor.mockImplementation(() => {
        queueMicrotask(() => mockWs.emit("open"));
        return mockWs;
      });

      const origSend = mockWs.send.bind(mockWs);
      mockWs.send = vi.fn((data: string) => {
        origSend(data);
        const parsed = JSON.parse(data);
        if (parsed.method === "initialize") {
          queueMicrotask(() => {
            mockWs.emit(
              "message",
              Buffer.from(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: parsed.id,
                  error: { message: "unsupported client version" },
                }),
              ),
            );
          });
        }
      });

      await expect(adapter.connect({ sessionId: "hs-err-session" })).rejects.toThrow(
        "Initialize handshake failed: unsupported client version",
      );
    });

    it("rejects when WebSocket emits error during handshake", async () => {
      const mockWs = new MockWebSocket();

      mockWsConstructor.mockImplementation(() => {
        queueMicrotask(() => mockWs.emit("open"));
        return mockWs;
      });

      const origSend = mockWs.send.bind(mockWs);
      mockWs.send = vi.fn((data: string) => {
        origSend(data);
        const parsed = JSON.parse(data);
        if (parsed.method === "initialize") {
          queueMicrotask(() => {
            mockWs.emit("error", new Error("socket hung up"));
          });
        }
      });

      await expect(adapter.connect({ sessionId: "hs-ws-err" })).rejects.toThrow(
        "WebSocket error during handshake: socket hung up",
      );
    });
  });
});
