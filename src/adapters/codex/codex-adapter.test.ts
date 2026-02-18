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

  terminate(): void {
    this.readyState = 3; // CLOSED
  }

  removeListener(event: string, listener: (...args: any[]) => void): this {
    return super.removeListener(event, listener);
  }
}

// ---------------------------------------------------------------------------
// Mock `ws` module for CodexAdapter.connect() tests.
// The factory returns a constructor fn whose behavior is set per-test.
// ---------------------------------------------------------------------------

// Factory fn whose behavior is set per-test via mockWsFactory.
// Vitest 4 requires class-like constructors for `new` calls.
let mockWsFactory: (...args: any[]) => MockWebSocket;

const MockWsClass = vi.hoisted(() => {
  // Wrap in a real function so it can be called with `new`
  function WsConstructor(this: any, ...args: any[]) {
    return mockWsFactory(...args);
  }
  WsConstructor.OPEN = 1;
  WsConstructor.CLOSED = 3;
  WsConstructor.CONNECTING = 0;
  WsConstructor.CLOSING = 2;
  return WsConstructor;
});

vi.mock("ws", () => ({
  default: MockWsClass,
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
        connectRetries: 2,
        connectRetryDelayMs: 0,
      });
      launchSpy = vi
        .spyOn(CodexLauncher.prototype, "launch")
        .mockResolvedValue({ url: "ws://127.0.0.1:9999", pid: 12345 });
    });

    afterEach(() => {
      launchSpy.mockRestore();
    });

    /** Configure mockWsFactory to return a MockWebSocket that emits "open". */
    function setupOpenableWs(): MockWebSocket {
      const ws = new MockWebSocket();
      mockWsFactory = () => {
        queueMicrotask(() => ws.emit("open"));
        return ws;
      };
      return ws;
    }

    /** Intercept `send` so that when the adapter sends an "initialize" request,
     *  the mock WebSocket responds with the given JSON-RPC reply. */
    function interceptInitialize(ws: MockWebSocket, replyFn: (requestId: number) => void): void {
      const origSend = ws.send.bind(ws);
      ws.send = vi.fn((data: string) => {
        origSend(data);
        const parsed = JSON.parse(data);
        if (parsed.method === "initialize") {
          queueMicrotask(() => replyFn(parsed.id));
        }
      });
    }

    it("returns a CodexSession on successful connect and handshake", async () => {
      const ws = setupOpenableWs();
      interceptInitialize(ws, (id) => {
        ws.emit(
          "message",
          Buffer.from(
            JSON.stringify({
              jsonrpc: "2.0",
              id,
              result: { capabilities: { streaming: true }, version: "1.0.0" },
            }),
          ),
        );
      });

      const session = await adapter.connect({ sessionId: "test-codex-session" });

      expect(session).toBeInstanceOf(CodexSession);
      expect(launchSpy).toHaveBeenCalledWith("test-codex-session", expect.any(Object));
      const sentMessages = ws.sent.map((s) => JSON.parse(s));
      expect(sentMessages.some((m: any) => m.method === "initialized")).toBe(true);
    });

    it("rejects when WebSocket emits error during connection (all retries)", async () => {
      mockWsFactory = () => {
        const ws = new MockWebSocket();
        queueMicrotask(() => ws.emit("error", new Error("Connection refused")));
        return ws;
      };

      await expect(adapter.connect({ sessionId: "err-session" })).rejects.toThrow(
        "Failed to connect to codex app-server",
      );
    });

    it("succeeds after retrying a failed WebSocket connection", async () => {
      let attempt = 0;
      const successWs = new MockWebSocket();

      mockWsFactory = () => {
        attempt++;
        if (attempt === 1) {
          const failWs = new MockWebSocket();
          queueMicrotask(() => failWs.emit("error", new Error("Connection refused")));
          return failWs;
        }
        // Second attempt succeeds
        queueMicrotask(() => successWs.emit("open"));
        return successWs;
      };

      // Intercept handshake on the successful WebSocket
      const origSend = successWs.send.bind(successWs);
      successWs.send = vi.fn((data: string) => {
        origSend(data);
        const parsed = JSON.parse(data);
        if (parsed.method === "initialize") {
          queueMicrotask(() =>
            successWs.emit(
              "message",
              Buffer.from(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: parsed.id,
                  result: { capabilities: {}, version: "1.0.0" },
                }),
              ),
            ),
          );
        }
      });

      const session = await adapter.connect({ sessionId: "retry-success" });
      expect(session).toBeInstanceOf(CodexSession);
      expect(attempt).toBe(2);
    });

    it("rejects when handshake times out", async () => {
      vi.useFakeTimers();
      const ws = setupOpenableWs();
      // Don't intercept initialize — let the handshake hang

      const connectPromise = adapter.connect({ sessionId: "hs-timeout" });

      // Attach catch handler before advancing so the rejection isn't unhandled
      await Promise.all([
        expect(connectPromise).rejects.toThrow("Initialize handshake timed out"),
        vi.advanceTimersByTimeAsync(10_001),
      ]);

      vi.useRealTimers();
    });

    it("rejects when handshake returns an error response", async () => {
      const ws = setupOpenableWs();
      interceptInitialize(ws, (id) => {
        ws.emit(
          "message",
          Buffer.from(
            JSON.stringify({
              jsonrpc: "2.0",
              id,
              error: { message: "unsupported client version" },
            }),
          ),
        );
      });

      await expect(adapter.connect({ sessionId: "hs-err-session" })).rejects.toThrow(
        "Initialize handshake failed: unsupported client version",
      );
    });

    it("rejects when WebSocket emits error during handshake", async () => {
      const ws = setupOpenableWs();
      interceptInitialize(ws, () => {
        ws.emit("error", new Error("socket hung up"));
      });

      await expect(adapter.connect({ sessionId: "hs-ws-err" })).rejects.toThrow(
        "WebSocket error during handshake",
      );
    });
  });
});
