import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { UnifiedMessage } from "../../core/types/unified-message.js";
import { createUnifiedMessage } from "../../core/types/unified-message.js";
import { SdkUrlSession } from "./sdk-url-session.js";

// ---------------------------------------------------------------------------
// Mock WebSocket
// ---------------------------------------------------------------------------

class MockWebSocket extends EventEmitter {
  readyState = 1; // OPEN
  sent: string[] = [];

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3; // CLOSED
    this.emit("close");
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeUserMsg(text = "hello"): UnifiedMessage {
  return createUnifiedMessage({
    type: "user_message",
    role: "user",
    content: [{ type: "text", text }],
  });
}

function tick(ms = 10): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SdkUrlSession", () => {
  // -------------------------------------------------------------------------
  // 1. send() before socket connect queues the message
  // -------------------------------------------------------------------------

  it("send() before socket connect queues the message", async () => {
    let resolveSocket!: (ws: MockWebSocket) => void;
    const socketPromise = new Promise<MockWebSocket>((r) => {
      resolveSocket = r;
    });

    const session = new SdkUrlSession({
      sessionId: "s-1",
      socketPromise: socketPromise as any,
    });

    const ws = new MockWebSocket();

    // Send before socket connects
    session.send(makeUserMsg());
    expect(ws.sent).toHaveLength(0);

    // Resolve socket
    resolveSocket(ws);
    await tick();

    // Message should now be flushed
    expect(ws.sent).toHaveLength(1);
    const parsed = JSON.parse(ws.sent[0]);
    expect(parsed.type).toBe("user");
    expect(parsed.message.role).toBe("user");

    await session.close();
  });

  // -------------------------------------------------------------------------
  // 2. sendRaw() queues before socket and sends after
  // -------------------------------------------------------------------------

  it("sendRaw() queues before socket and sends after", async () => {
    let resolveSocket!: (ws: MockWebSocket) => void;
    const socketPromise = new Promise<MockWebSocket>((r) => {
      resolveSocket = r;
    });

    const session = new SdkUrlSession({
      sessionId: "s-1",
      socketPromise: socketPromise as any,
    });

    const ws = new MockWebSocket();
    const rawData = '{"type":"custom","data":"test"}';

    // sendRaw before socket connects
    session.sendRaw(rawData);
    expect(ws.sent).toHaveLength(0);

    // Resolve socket
    resolveSocket(ws);
    await tick();

    // Raw data should be flushed
    expect(ws.sent).toHaveLength(1);
    expect(ws.sent[0]).toBe(rawData);

    await session.close();
  });

  // -------------------------------------------------------------------------
  // 3. after socket resolves, queued messages are flushed in order
  // -------------------------------------------------------------------------

  it("after socket resolves, queued messages are flushed in order", async () => {
    let resolveSocket!: (ws: MockWebSocket) => void;
    const socketPromise = new Promise<MockWebSocket>((r) => {
      resolveSocket = r;
    });

    const session = new SdkUrlSession({
      sessionId: "s-1",
      socketPromise: socketPromise as any,
    });

    const ws = new MockWebSocket();
    const rawData = '{"type":"raw","data":"test"}';

    // Queue both send() and sendRaw() before socket connects
    session.send(makeUserMsg("first"));
    session.sendRaw(rawData);

    // Resolve socket
    resolveSocket(ws);
    await tick();

    // Both should be flushed in order
    expect(ws.sent).toHaveLength(2);

    // First: translated user message
    const first = JSON.parse(ws.sent[0]);
    expect(first.type).toBe("user");

    // Second: raw NDJSON
    expect(ws.sent[1]).toBe(rawData);

    await session.close();
  });

  // -------------------------------------------------------------------------
  // 4. incoming WS data translated to UnifiedMessage in async iterable
  // -------------------------------------------------------------------------

  it("incoming WS data translated to UnifiedMessage in async iterable", async () => {
    const ws = new MockWebSocket();
    const socketPromise = Promise.resolve(ws);

    const session = new SdkUrlSession({
      sessionId: "s-1",
      socketPromise: socketPromise as any,
    });

    await tick();

    // Emit a system init message via WebSocket
    const initMsg = JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: "cli-sess-1",
      cwd: "/home/user",
      model: "claude-sonnet-4-5-20250929",
      tools: ["Bash"],
      mcp_servers: [],
      permissionMode: "default",
      apiKeySource: "env",
      claude_code_version: "1.0.0",
      slash_commands: [],
      output_style: "streaming",
      uuid: "uuid-1",
    });

    ws.emit("message", Buffer.from(initMsg));

    const iter = session.messages[Symbol.asyncIterator]();
    const { value, done } = await iter.next();

    expect(done).toBe(false);
    expect(value.type).toBe("session_init");
    expect(value.role).toBe("system");
    expect(value.metadata.session_id).toBe("cli-sess-1");
    expect(value.metadata.model).toBe("claude-sonnet-4-5-20250929");

    await session.close();
  });

  // -------------------------------------------------------------------------
  // 5. close() terminates async iterable
  // -------------------------------------------------------------------------

  it("close() terminates async iterable", async () => {
    const ws = new MockWebSocket();
    const socketPromise = Promise.resolve(ws);

    const session = new SdkUrlSession({
      sessionId: "s-1",
      socketPromise: socketPromise as any,
    });

    await tick();

    const iter = session.messages[Symbol.asyncIterator]();

    // Start waiting for a message (will hang until close() signals done)
    const nextPromise = iter.next();

    await session.close();

    const result = await nextPromise;
    expect(result.done).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 6. toNDJSON() returning null logs warning, doesn't crash
  // -------------------------------------------------------------------------

  it("toNDJSON() returning null logs warning, doesn't crash", async () => {
    const ws = new MockWebSocket();
    const socketPromise = Promise.resolve(ws);

    const session = new SdkUrlSession({
      sessionId: "s-1",
      socketPromise: socketPromise as any,
    });

    await tick();

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // session_init is a backend→consumer type; toNDJSON returns null for it
    const msg = createUnifiedMessage({
      type: "session_init",
      role: "system",
      metadata: { session_id: "test" },
    });

    // Should not throw
    session.send(msg);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('toNDJSON returned null for message type "session_init"'),
    );

    // Nothing should have been sent to the socket
    expect(ws.sent).toHaveLength(0);

    warnSpy.mockRestore();
    await session.close();
  });

  // -------------------------------------------------------------------------
  // 7. send() on closed session throws
  // -------------------------------------------------------------------------

  it("send() on closed session throws", async () => {
    const ws = new MockWebSocket();
    const socketPromise = Promise.resolve(ws);

    const session = new SdkUrlSession({
      sessionId: "s-1",
      socketPromise: socketPromise as any,
    });

    await tick();
    await session.close();

    expect(() => session.send(makeUserMsg())).toThrow("Session is closed");
  });

  // -------------------------------------------------------------------------
  // 8. user type CLI messages (echoes) are filtered out
  // -------------------------------------------------------------------------

  it("user type CLI messages (echoes) are filtered out", async () => {
    const ws = new MockWebSocket();
    const socketPromise = Promise.resolve(ws);

    const session = new SdkUrlSession({
      sessionId: "s-1",
      socketPromise: socketPromise as any,
    });

    await tick();

    // Emit a "user" echo message (translate() returns null for these)
    const userEcho = JSON.stringify({
      type: "user",
      message: { role: "user", content: "test" },
      parent_tool_use_id: null,
    });
    ws.emit("message", Buffer.from(userEcho));

    // Now emit a real message that will be translated
    const assistantMsg = JSON.stringify({
      type: "assistant",
      message: {
        id: "msg-1",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-5-20250929",
        content: [{ type: "text", text: "Hello" }],
        stop_reason: "end_turn",
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
      parent_tool_use_id: null,
      uuid: "uuid-1",
      session_id: "s-1",
    });
    ws.emit("message", Buffer.from(assistantMsg));

    const iter = session.messages[Symbol.asyncIterator]();
    const { value, done } = await iter.next();

    // The user echo should have been filtered out; we should get the assistant message
    expect(done).toBe(false);
    expect(value.type).toBe("assistant");
    expect(value.role).toBe("assistant");

    await session.close();
  });

  // -------------------------------------------------------------------------
  // sendRaw() on closed session throws
  // -------------------------------------------------------------------------

  it("sendRaw() on closed session throws", async () => {
    const ws = new MockWebSocket();
    const socketPromise = Promise.resolve(ws);

    const session = new SdkUrlSession({
      sessionId: "s-1",
      socketPromise: socketPromise as any,
    });

    await tick();
    await session.close();

    expect(() => session.sendRaw('{"type":"test"}')).toThrow("Session is closed");
  });

  // -------------------------------------------------------------------------
  // passthrough handler
  // -------------------------------------------------------------------------

  describe("passthrough handler", () => {
    it("suppresses user messages when handler returns true", async () => {
      const { resolve, promise } = Promise.withResolvers<any>();
      const session = new SdkUrlSession({ sessionId: "pt-1", socketPromise: promise });

      const intercepted: any[] = [];
      session.setPassthroughHandler((msg) => {
        intercepted.push(msg);
        return true; // intercept
      });

      const ws = new MockWebSocket();
      resolve(ws);
      await tick();

      const iter = session.messages[Symbol.asyncIterator]();

      // Send a user echo message
      ws.emit(
        "message",
        JSON.stringify({ type: "user", message: { role: "user", content: "echo" } }),
      );

      // Also send a system message to verify the iterable still works
      ws.emit(
        "message",
        JSON.stringify({
          type: "system",
          subtype: "init",
          session_id: "pt-1",
          model: "test",
          cwd: "/tmp",
          tools: [],
          mcp_servers: [],
        }),
      );

      const result = await iter.next();
      expect(result.done).toBe(false);
      expect(result.value.type).toBe("session_init");

      // The user message was intercepted, not yielded
      expect(intercepted).toHaveLength(1);
      expect(intercepted[0].type).toBe("user");

      await session.close();
    });

    it("yields user messages when no handler is set (translate returns null)", async () => {
      const { resolve, promise } = Promise.withResolvers<any>();
      const session = new SdkUrlSession({ sessionId: "pt-2", socketPromise: promise });
      // No handler set

      const ws = new MockWebSocket();
      resolve(ws);
      await tick();

      const iter = session.messages[Symbol.asyncIterator]();

      // User messages are filtered by translate() returning null
      ws.emit(
        "message",
        JSON.stringify({ type: "user", message: { role: "user", content: "test" } }),
      );

      // Send a real message to unblock
      ws.emit(
        "message",
        JSON.stringify({
          type: "system",
          subtype: "init",
          session_id: "pt-2",
          model: "test",
          cwd: "/tmp",
          tools: [],
          mcp_servers: [],
        }),
      );

      const result = await iter.next();
      expect(result.value.type).toBe("session_init"); // user was filtered by translate

      await session.close();
    });

    it("yields user messages when handler returns false", async () => {
      const { resolve, promise } = Promise.withResolvers<any>();
      const session = new SdkUrlSession({ sessionId: "pt-3", socketPromise: promise });

      session.setPassthroughHandler(() => false); // don't intercept

      const ws = new MockWebSocket();
      resolve(ws);
      await tick();

      const iter = session.messages[Symbol.asyncIterator]();

      // User message not intercepted, goes to translate() which returns null
      ws.emit(
        "message",
        JSON.stringify({ type: "user", message: { role: "user", content: "test" } }),
      );

      // Send real message
      ws.emit(
        "message",
        JSON.stringify({
          type: "system",
          subtype: "init",
          session_id: "pt-3",
          model: "test",
          cwd: "/tmp",
          tools: [],
          mcp_servers: [],
        }),
      );

      const result = await iter.next();
      expect(result.value.type).toBe("session_init"); // user filtered by translate

      await session.close();
    });

    it("handler receives the raw parsed CLI message", async () => {
      const { resolve, promise } = Promise.withResolvers<any>();
      const session = new SdkUrlSession({ sessionId: "pt-4", socketPromise: promise });

      let received: any = null;
      session.setPassthroughHandler((msg) => {
        received = msg;
        return true;
      });

      const ws = new MockWebSocket();
      resolve(ws);
      await tick();

      const userMsg = { type: "user", message: { role: "user", content: "/cost response" } };
      ws.emit("message", JSON.stringify(userMsg));
      await tick();

      expect(received).toEqual(userMsg);

      await session.close();
    });

    it("handler can be cleared by setting null", async () => {
      const { resolve, promise } = Promise.withResolvers<any>();
      const session = new SdkUrlSession({ sessionId: "pt-5", socketPromise: promise });

      session.setPassthroughHandler(() => true);
      session.setPassthroughHandler(null); // clear

      const ws = new MockWebSocket();
      resolve(ws);
      await tick();

      // Now user messages go through translate (which returns null for user type)
      ws.emit(
        "message",
        JSON.stringify({ type: "user", message: { role: "user", content: "test" } }),
      );
      ws.emit(
        "message",
        JSON.stringify({
          type: "system",
          subtype: "init",
          session_id: "pt-5",
          model: "test",
          cwd: "/tmp",
          tools: [],
          mcp_servers: [],
        }),
      );

      const iter = session.messages[Symbol.asyncIterator]();
      const result = await iter.next();
      expect(result.value.type).toBe("session_init");

      await session.close();
    });
  });

  // -------------------------------------------------------------------------
  // socket promise rejection triggers finish
  // -------------------------------------------------------------------------

  it("socket promise rejection terminates the session", async () => {
    const socketPromise = Promise.reject(new Error("connection failed"));

    const session = new SdkUrlSession({
      sessionId: "s-1",
      socketPromise: socketPromise as any,
    });

    await tick();

    const iter = session.messages[Symbol.asyncIterator]();
    const result = await iter.next();
    expect(result.done).toBe(true);
  });

  // -------------------------------------------------------------------------
  // close() before socket resolves cleans up properly
  // -------------------------------------------------------------------------

  it("close() before socket resolves closes socket on arrival", async () => {
    let resolveSocket!: (ws: MockWebSocket) => void;
    const socketPromise = new Promise<MockWebSocket>((r) => {
      resolveSocket = r;
    });

    const session = new SdkUrlSession({
      sessionId: "s-1",
      socketPromise: socketPromise as any,
    });

    // Close before socket resolves
    await session.close();

    const ws = new MockWebSocket();
    resolveSocket(ws);
    await tick();

    // Socket should have been closed since session was already closed
    expect(ws.readyState).toBe(3); // CLOSED
  });
});
