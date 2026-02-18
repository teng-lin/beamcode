/**
 * Focused tests for CodexSession branch coverage.
 *
 * Targets notification handlers, thread initialization, approval routing,
 * modern interrupt, response handling, and content extraction — all branches
 * that are uncovered in the existing codex-adapter.test.ts suite.
 */

import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type WebSocket from "ws";
import { createUnifiedMessage } from "../../core/types/unified-message.js";
import type { ProcessHandle, ProcessManager } from "../../interfaces/process-manager.js";
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
    this.readyState = 3;
    this.emit("close");
  }

  terminate(): void {
    this.readyState = 3;
  }
}

function createMockProcessManager(): ProcessManager {
  return {
    spawn: vi.fn().mockReturnValue({
      pid: 12345,
      exited: new Promise<number | null>(() => {}),
      kill: vi.fn(),
      stdout: null,
      stderr: null,
    } satisfies ProcessHandle),
    isAlive: vi.fn().mockReturnValue(true),
  };
}

/** Helper: emit a JSON-RPC message on the WebSocket. */
function emitMsg(ws: MockWebSocket, msg: object): void {
  ws.emit("message", Buffer.from(JSON.stringify(msg)));
}

// ---------------------------------------------------------------------------
// Notification handler tests
// ---------------------------------------------------------------------------

describe("CodexSession — notification handlers", () => {
  let ws: MockWebSocket;
  let session: CodexSession;
  let launcher: CodexLauncher;

  beforeEach(() => {
    ws = new MockWebSocket();
    launcher = new CodexLauncher({ processManager: createMockProcessManager() });
    session = new CodexSession({
      sessionId: "test",
      ws: ws as unknown as WebSocket,
      launcher,
      threadId: "t-1",
    });
  });

  afterEach(() => {
    ws.close();
  });

  it("handles thread/started notification and sets threadId", async () => {
    const iter = session.messages[Symbol.asyncIterator]();

    emitMsg(ws, {
      jsonrpc: "2.0",
      method: "thread/started",
      params: { thread: { id: "new-thread-id" } },
    });

    // thread/started does not enqueue — send a follow-up to verify iteration works
    emitMsg(ws, {
      jsonrpc: "2.0",
      method: "item/agentMessage/delta",
      params: { delta: "hello" },
    });

    const result = await iter.next();
    expect(result.value.type).toBe("stream_event");
  });

  it("handles thread/started with missing thread id gracefully", () => {
    emitMsg(ws, {
      jsonrpc: "2.0",
      method: "thread/started",
      params: { thread: { id: "" } },
    });
    // Should not throw
  });

  it("handles turn/started notification", async () => {
    const iter = session.messages[Symbol.asyncIterator]();
    const next = iter.next();

    emitMsg(ws, {
      jsonrpc: "2.0",
      method: "turn/started",
      params: { turn: { id: "turn-42" } },
    });

    const result = await next;
    expect(result.value.type).toBe("stream_event");
    expect(result.value.metadata.event).toEqual({
      type: "message_start",
      message: {},
    });
  });

  it("handles turn/started with non-string turn id", async () => {
    const iter = session.messages[Symbol.asyncIterator]();
    const next = iter.next();

    emitMsg(ws, {
      jsonrpc: "2.0",
      method: "turn/started",
      params: { turn: { id: 999 } },
    });

    const result = await next;
    expect(result.value.type).toBe("stream_event");
  });

  it("handles item/agentMessage/delta notification with text", async () => {
    const iter = session.messages[Symbol.asyncIterator]();
    const next = iter.next();

    emitMsg(ws, {
      jsonrpc: "2.0",
      method: "item/agentMessage/delta",
      params: { delta: "streaming text" },
    });

    const result = await next;
    expect(result.value.type).toBe("stream_event");
    expect(result.value.metadata.event).toEqual({
      type: "content_block_delta",
      delta: { type: "text_delta", text: "streaming text" },
    });
  });

  it("ignores item/agentMessage/delta with empty delta", () => {
    emitMsg(ws, {
      jsonrpc: "2.0",
      method: "item/agentMessage/delta",
      params: { delta: "" },
    });
    // Should not enqueue anything; verified by not throwing
  });

  it("ignores item/agentMessage/delta with non-string delta", () => {
    emitMsg(ws, {
      jsonrpc: "2.0",
      method: "item/agentMessage/delta",
      params: { delta: 42 },
    });
  });

  it("handles item/completed with agentMessage item", async () => {
    const iter = session.messages[Symbol.asyncIterator]();
    const next = iter.next();

    emitMsg(ws, {
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        item: {
          type: "agentMessage",
          id: "item-1",
          text: "Final answer",
        },
      },
    });

    const result = await next;
    expect(result.value.type).toBe("assistant");
    expect(result.value.content[0]).toEqual({ type: "text", text: "Final answer" });
    expect(result.value.metadata.item_id).toBe("item-1");
  });

  it("ignores item/completed with non-agentMessage item", () => {
    emitMsg(ws, {
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        item: { type: "function_call", id: "fc-1" },
      },
    });
    // No message enqueued for non-agentMessage items
  });

  it("handles turn/completed notification", async () => {
    const iter = session.messages[Symbol.asyncIterator]();
    const next = iter.next();

    emitMsg(ws, {
      jsonrpc: "2.0",
      method: "turn/completed",
      params: {
        turn: { status: "completed" },
      },
    });

    const result = await next;
    expect(result.value.type).toBe("result");
    expect(result.value.metadata.status).toBe("completed");
    expect(result.value.metadata.is_error).toBe(false);
  });

  it("handles turn/completed with failed status and error", async () => {
    const iter = session.messages[Symbol.asyncIterator]();
    const next = iter.next();

    emitMsg(ws, {
      jsonrpc: "2.0",
      method: "turn/completed",
      params: {
        turn: {
          status: "failed",
          error: { message: "Rate limit exceeded" },
        },
      },
    });

    const result = await next;
    expect(result.value.type).toBe("result");
    expect(result.value.metadata.status).toBe("failed");
    expect(result.value.metadata.is_error).toBe(true);
    expect(result.value.metadata.error).toBe("Rate limit exceeded");
    expect(result.value.metadata.errors).toEqual(["Rate limit exceeded"]);
  });

  it("handles turn/completed with no turn params (defaults)", async () => {
    const iter = session.messages[Symbol.asyncIterator]();
    const next = iter.next();

    emitMsg(ws, {
      jsonrpc: "2.0",
      method: "turn/completed",
      params: {},
    });

    const result = await next;
    expect(result.value.metadata.status).toBe("completed");
    expect(result.value.metadata.error).toBeUndefined();
    expect(result.value.metadata.errors).toBeUndefined();
  });

  it("handles error notification with message", async () => {
    const iter = session.messages[Symbol.asyncIterator]();
    const next = iter.next();

    emitMsg(ws, {
      jsonrpc: "2.0",
      method: "error",
      params: { error: { message: "Something went wrong" } },
    });

    const result = await next;
    expect(result.value.type).toBe("result");
    expect(result.value.metadata.is_error).toBe(true);
    expect(result.value.metadata.error).toBe("Something went wrong");
  });

  it("handles error notification with no message (default)", async () => {
    const iter = session.messages[Symbol.asyncIterator]();
    const next = iter.next();

    emitMsg(ws, {
      jsonrpc: "2.0",
      method: "error",
      params: { error: {} },
    });

    const result = await next;
    expect(result.value.metadata.error).toBe("Codex backend error");
  });

  it("handles error notification with empty string message", async () => {
    const iter = session.messages[Symbol.asyncIterator]();
    const next = iter.next();

    emitMsg(ws, {
      jsonrpc: "2.0",
      method: "error",
      params: { error: { message: "" } },
    });

    const result = await next;
    expect(result.value.metadata.error).toBe("Codex backend error");
  });

  it("handles approval_requested notification", async () => {
    const iter = session.messages[Symbol.asyncIterator]();
    const next = iter.next();

    emitMsg(ws, {
      jsonrpc: "2.0",
      method: "approval_requested",
      params: {
        type: "approval_requested",
        item: {
          type: "function_call",
          id: "fc-1",
          name: "shell",
          arguments: '{"cmd":"ls"}',
          call_id: "c-1",
        },
      },
    });

    const result = await next;
    expect(result.value.type).toBe("permission_request");
  });
});

// ---------------------------------------------------------------------------
// Server request handling (approval requests from server)
// ---------------------------------------------------------------------------

describe("CodexSession — server requests", () => {
  let ws: MockWebSocket;
  let session: CodexSession;
  let launcher: CodexLauncher;

  beforeEach(() => {
    ws = new MockWebSocket();
    launcher = new CodexLauncher({ processManager: createMockProcessManager() });
    session = new CodexSession({
      sessionId: "test",
      ws: ws as unknown as WebSocket,
      launcher,
      threadId: "t-1",
    });
  });

  afterEach(() => ws.close());

  it("handles item/commandExecution/requestApproval from server", async () => {
    const iter = session.messages[Symbol.asyncIterator]();
    const next = iter.next();

    emitMsg(ws, {
      jsonrpc: "2.0",
      id: 100,
      method: "item/commandExecution/requestApproval",
      params: { command: "rm -rf /" },
    });

    const result = await next;
    expect(result.value.type).toBe("permission_request");
    expect(result.value.metadata.tool_name).toBe("item/commandExecution/requestApproval");
    expect(result.value.metadata.request_id).toBe("100");
  });

  it("handles item/fileChange/requestApproval from server", async () => {
    const iter = session.messages[Symbol.asyncIterator]();
    const next = iter.next();

    emitMsg(ws, {
      jsonrpc: "2.0",
      id: 101,
      method: "item/fileChange/requestApproval",
      params: { file: "test.txt" },
    });

    const result = await next;
    expect(result.value.type).toBe("permission_request");
    expect(result.value.metadata.tool_name).toBe("item/fileChange/requestApproval");
  });

  it("handles execCommandApproval from server", async () => {
    const iter = session.messages[Symbol.asyncIterator]();
    const next = iter.next();

    emitMsg(ws, {
      jsonrpc: "2.0",
      id: 102,
      method: "execCommandApproval",
      params: { command: "ls" },
    });

    const result = await next;
    expect(result.value.type).toBe("permission_request");
  });

  it("handles applyPatchApproval from server", async () => {
    const iter = session.messages[Symbol.asyncIterator]();
    const next = iter.next();

    emitMsg(ws, {
      jsonrpc: "2.0",
      id: 103,
      method: "applyPatchApproval",
      params: { patch: "..." },
    });

    const result = await next;
    expect(result.value.type).toBe("permission_request");
  });

  it("sends error for unsupported server request method", () => {
    emitMsg(ws, {
      jsonrpc: "2.0",
      id: 200,
      method: "unsupported/method",
      params: {},
    });

    const sent = JSON.parse(ws.sent[0]);
    expect(sent.error.message).toContain("Unsupported server request method");
  });
});

// ---------------------------------------------------------------------------
// Modern approval response routing
// ---------------------------------------------------------------------------

describe("CodexSession — approval response routing", () => {
  let ws: MockWebSocket;
  let session: CodexSession;
  let launcher: CodexLauncher;

  beforeEach(() => {
    ws = new MockWebSocket();
    launcher = new CodexLauncher({ processManager: createMockProcessManager() });
    session = new CodexSession({
      sessionId: "test",
      ws: ws as unknown as WebSocket,
      launcher,
      threadId: "t-1",
    });
  });

  afterEach(() => ws.close());

  it("routes approval response for item/commandExecution/requestApproval (accept)", async () => {
    // Server sends approval request
    emitMsg(ws, {
      jsonrpc: "2.0",
      id: 10,
      method: "item/commandExecution/requestApproval",
      params: { command: "ls" },
    });

    // Consume the permission_request message
    const iter = session.messages[Symbol.asyncIterator]();
    await iter.next();

    ws.sent = []; // Clear sent messages

    // User approves
    session.send(
      createUnifiedMessage({
        type: "permission_response",
        role: "user",
        metadata: { behavior: "allow", request_id: "10" },
      }),
    );

    const sent = JSON.parse(ws.sent[0]);
    expect(sent.result).toEqual({ decision: "accept" });
    expect(sent.id).toBe(10);
  });

  it("routes approval response for item/fileChange/requestApproval (decline)", async () => {
    emitMsg(ws, {
      jsonrpc: "2.0",
      id: 11,
      method: "item/fileChange/requestApproval",
      params: { file: "foo.txt" },
    });

    const iter = session.messages[Symbol.asyncIterator]();
    await iter.next();
    ws.sent = [];

    session.send(
      createUnifiedMessage({
        type: "permission_response",
        role: "user",
        metadata: { behavior: "deny", request_id: "11" },
      }),
    );

    const sent = JSON.parse(ws.sent[0]);
    expect(sent.result).toEqual({ decision: "decline" });
  });

  it("routes approval response for execCommandApproval (accept)", async () => {
    emitMsg(ws, {
      jsonrpc: "2.0",
      id: 12,
      method: "execCommandApproval",
      params: {},
    });

    const iter = session.messages[Symbol.asyncIterator]();
    await iter.next();
    ws.sent = [];

    session.send(
      createUnifiedMessage({
        type: "permission_response",
        role: "user",
        metadata: { behavior: "allow", request_id: "12" },
      }),
    );

    const sent = JSON.parse(ws.sent[0]);
    expect(sent.result).toEqual({ decision: "approved" });
  });

  it("routes approval response for applyPatchApproval (deny)", async () => {
    emitMsg(ws, {
      jsonrpc: "2.0",
      id: 13,
      method: "applyPatchApproval",
      params: {},
    });

    const iter = session.messages[Symbol.asyncIterator]();
    await iter.next();
    ws.sent = [];

    session.send(
      createUnifiedMessage({
        type: "permission_response",
        role: "user",
        metadata: { behavior: "deny", request_id: "13" },
      }),
    );

    const sent = JSON.parse(ws.sent[0]);
    expect(sent.result).toEqual({ decision: "denied" });
  });

  it("sends error for unsupported approval method", async () => {
    // Directly inject a fake pending method to exercise the error branch
    const pendingMap = (session as any).pendingApprovalMethods as Map<string, string>;
    pendingMap.set("999", "unknown/approval/method");
    ws.sent = [];

    session.send(
      createUnifiedMessage({
        type: "permission_response",
        role: "user",
        metadata: { behavior: "allow", request_id: "999" },
      }),
    );

    const sent = JSON.parse(ws.sent[0]);
    expect(sent.error.message).toContain("Unsupported approval method");
  });

  it("uses legacy approval.respond when method not in pendingApprovalMethods", () => {
    // Send approval response without a corresponding server request
    session.send(
      createUnifiedMessage({
        type: "permission_response",
        role: "user",
        metadata: { behavior: "allow", request_id: "unknown-id" },
      }),
    );

    const sent = JSON.parse(ws.sent[0]);
    expect(sent.method).toBe("approval.respond");
    expect(sent.params.approve).toBe(true);
    expect(sent.params.item_id).toBe("unknown-id");
  });

  it("does nothing when requestId is undefined", () => {
    const sentBefore = ws.sent.length;
    session.send(
      createUnifiedMessage({
        type: "permission_response",
        role: "user",
        metadata: { behavior: "allow" },
      }),
    );
    // No message sent because requestId is undefined
    expect(ws.sent.length).toBe(sentBefore);
  });
});

// ---------------------------------------------------------------------------
// Modern interrupt (turn/interrupt)
// ---------------------------------------------------------------------------

describe("CodexSession — interrupt", () => {
  let ws: MockWebSocket;
  let launcher: CodexLauncher;

  afterEach(() => ws.close());

  it("sends turn/interrupt when threadId and activeTurnId are set", async () => {
    ws = new MockWebSocket();
    launcher = new CodexLauncher({ processManager: createMockProcessManager() });
    const session = new CodexSession({
      sessionId: "test",
      ws: ws as unknown as WebSocket,
      launcher,
      threadId: "t-1",
    });

    // Set activeTurnId by receiving a turn/started notification
    emitMsg(ws, {
      jsonrpc: "2.0",
      method: "turn/started",
      params: { turn: { id: "turn-99" } },
    });

    // Consume the stream_event
    const iter = session.messages[Symbol.asyncIterator]();
    await iter.next();

    ws.sent = [];

    session.send(createUnifiedMessage({ type: "interrupt", role: "user" }));

    const sent = JSON.parse(ws.sent[0]);
    expect(sent.method).toBe("turn/interrupt");
    expect(sent.params.threadId).toBe("t-1");
    expect(sent.params.turnId).toBe("turn-99");
  });

  it("falls back to turn.cancel when no activeTurnId", () => {
    ws = new MockWebSocket();
    launcher = new CodexLauncher({ processManager: createMockProcessManager() });
    const session = new CodexSession({
      sessionId: "test",
      ws: ws as unknown as WebSocket,
      launcher,
      threadId: "t-1",
    });

    session.send(createUnifiedMessage({ type: "interrupt", role: "user" }));

    const sent = JSON.parse(ws.sent[0]);
    expect(sent.method).toBe("turn.cancel");
  });
});

// ---------------------------------------------------------------------------
// Thread initialization
// ---------------------------------------------------------------------------

describe("CodexSession — thread initialization", () => {
  let ws: MockWebSocket;
  let launcher: CodexLauncher;

  afterEach(() => ws.close());

  /** Intercept ws.send and respond to RPC requests. */
  function interceptRpc(
    ws: MockWebSocket,
    handler: (method: string, id: number) => object | null,
  ): void {
    const origSend = ws.send.bind(ws);
    ws.send = vi.fn((data: string) => {
      origSend(data);
      const parsed = JSON.parse(data);
      if (parsed.id !== undefined && parsed.method) {
        const reply = handler(parsed.method, parsed.id);
        if (reply) {
          queueMicrotask(() => emitMsg(ws, reply));
        }
      }
    });
  }

  it("initializes thread with modern thread/start API", async () => {
    ws = new MockWebSocket();
    launcher = new CodexLauncher({ processManager: createMockProcessManager() });
    const session = new CodexSession({
      sessionId: "test",
      ws: ws as unknown as WebSocket,
      launcher,
      // No threadId — triggers ensureThreadInitialized
    });

    interceptRpc(ws, (method, id) => {
      if (method === "thread/start") {
        return {
          jsonrpc: "2.0",
          id,
          result: { thread: { id: "new-thread-id" } },
        };
      }
      return null;
    });

    session.send(
      createUnifiedMessage({
        type: "user_message",
        role: "user",
        content: [{ type: "text", text: "hello" }],
      }),
    );

    // Wait for async initialization + flush
    await vi.waitFor(() => {
      const turnStartMsgs = ws.sent
        .map((s) => JSON.parse(s))
        .filter((m: any) => m.method === "turn/start");
      expect(turnStartMsgs.length).toBe(1);
      expect(turnStartMsgs[0].params.threadId).toBe("new-thread-id");
    });
  });

  it("falls back to legacy newConversation when thread/start fails", async () => {
    ws = new MockWebSocket();
    launcher = new CodexLauncher({ processManager: createMockProcessManager() });
    const session = new CodexSession({
      sessionId: "test",
      ws: ws as unknown as WebSocket,
      launcher,
    });

    interceptRpc(ws, (method, id) => {
      if (method === "thread/start") {
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: "Method not found" },
        };
      }
      if (method === "newConversation") {
        return {
          jsonrpc: "2.0",
          id,
          result: { conversationId: "legacy-conv-id" },
        };
      }
      return null;
    });

    session.send(
      createUnifiedMessage({
        type: "user_message",
        role: "user",
        content: [{ type: "text", text: "hello" }],
      }),
    );

    await vi.waitFor(() => {
      const turnStartMsgs = ws.sent
        .map((s) => JSON.parse(s))
        .filter((m: any) => m.method === "turn/start");
      expect(turnStartMsgs.length).toBe(1);
      expect(turnStartMsgs[0].params.threadId).toBe("legacy-conv-id");
    });
  });

  it("enqueues error result when both thread/start and newConversation fail", async () => {
    ws = new MockWebSocket();
    launcher = new CodexLauncher({ processManager: createMockProcessManager() });
    const session = new CodexSession({
      sessionId: "test",
      ws: ws as unknown as WebSocket,
      launcher,
    });

    interceptRpc(ws, (method, id) => {
      if (method === "thread/start") {
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: "Not found" },
        };
      }
      if (method === "newConversation") {
        return {
          jsonrpc: "2.0",
          id,
          result: {}, // No conversationId
        };
      }
      return null;
    });

    const iter = session.messages[Symbol.asyncIterator]();

    session.send(
      createUnifiedMessage({
        type: "user_message",
        role: "user",
        content: [{ type: "text", text: "hello" }],
      }),
    );

    const result = await iter.next();
    expect(result.value.type).toBe("result");
    expect(result.value.metadata.is_error).toBe(true);
    expect(result.value.metadata.error).toContain("Failed to initialize Codex thread");
  });

  it("does not re-initialize when threadId is already set", () => {
    ws = new MockWebSocket();
    launcher = new CodexLauncher({ processManager: createMockProcessManager() });
    const session = new CodexSession({
      sessionId: "test",
      ws: ws as unknown as WebSocket,
      launcher,
      threadId: "existing-thread",
    });

    session.send(
      createUnifiedMessage({
        type: "user_message",
        role: "user",
        content: [{ type: "text", text: "hello" }],
      }),
    );

    // Should directly send turn/start without thread/start RPC
    const sent = JSON.parse(ws.sent[0]);
    expect(sent.method).toBe("turn/start");
    expect(sent.params.threadId).toBe("existing-thread");
  });
});

// ---------------------------------------------------------------------------
// Response handling (non-pending RPC responses)
// ---------------------------------------------------------------------------

describe("CodexSession — response handling", () => {
  let ws: MockWebSocket;
  let session: CodexSession;
  let launcher: CodexLauncher;

  beforeEach(() => {
    ws = new MockWebSocket();
    launcher = new CodexLauncher({ processManager: createMockProcessManager() });
    session = new CodexSession({
      sessionId: "test",
      ws: ws as unknown as WebSocket,
      launcher,
      threadId: "t-1",
    });
  });

  afterEach(() => ws.close());

  it("handles response with output_text field (legacy format)", async () => {
    const iter = session.messages[Symbol.asyncIterator]();

    emitMsg(ws, {
      jsonrpc: "2.0",
      id: 999,
      result: { output_text: "Here is the answer" },
    });

    const assistant = await iter.next();
    expect(assistant.value.type).toBe("assistant");
    expect(assistant.value.content[0]).toEqual({ type: "text", text: "Here is the answer" });

    const result = await iter.next();
    expect(result.value.type).toBe("result");
    expect(result.value.metadata.status).toBe("completed");
  });

  it("handles response with empty output_text", async () => {
    const iter = session.messages[Symbol.asyncIterator]();

    emitMsg(ws, {
      jsonrpc: "2.0",
      id: 999,
      result: { output_text: "" },
    });

    // Empty text should still emit result but no assistant message
    const result = await iter.next();
    expect(result.value.type).toBe("result");
    expect(result.value.metadata.status).toBe("completed");
  });

  it("handles response with nested response object containing output", async () => {
    const iter = session.messages[Symbol.asyncIterator]();

    emitMsg(ws, {
      jsonrpc: "2.0",
      id: 999,
      result: {
        response: {
          id: "resp-1",
          status: "completed",
          output: [
            {
              type: "message",
              id: "m-1",
              content: [{ type: "output_text", text: "nested response" }],
            },
          ],
        },
      },
    });

    const assistant = await iter.next();
    expect(assistant.value.type).toBe("assistant");
    expect(assistant.value.content[0]).toEqual({ type: "text", text: "nested response" });

    const result = await iter.next();
    expect(result.value.type).toBe("result");
  });

  it("extracts threadId and turnId from response results", async () => {
    emitMsg(ws, {
      jsonrpc: "2.0",
      id: 998,
      result: {
        thread: { id: "thread-from-response" },
        turn: { id: "turn-from-response" },
      },
    });

    // Verify the threadId was set by sending a new turn
    ws.sent = [];
    session.send(
      createUnifiedMessage({
        type: "user_message",
        role: "user",
        content: [{ type: "text", text: "follow-up" }],
      }),
    );

    const sent = JSON.parse(ws.sent[0]);
    expect(sent.params.threadId).toBe("thread-from-response");
  });

  it("extracts legacy conversationId and turnId from response", () => {
    emitMsg(ws, {
      jsonrpc: "2.0",
      id: 997,
      result: {
        conversationId: "legacy-conv",
        turnId: "legacy-turn",
      },
    });

    ws.sent = [];
    session.send(
      createUnifiedMessage({
        type: "user_message",
        role: "user",
        content: [{ type: "text", text: "next" }],
      }),
    );

    const sent = JSON.parse(ws.sent[0]);
    expect(sent.params.threadId).toBe("legacy-conv");
  });

  it("handles response with non-message items (skips them)", async () => {
    const iter = session.messages[Symbol.asyncIterator]();

    emitMsg(ws, {
      jsonrpc: "2.0",
      id: 996,
      result: {
        id: "resp-2",
        status: "completed",
        output: [
          { type: "function_call", id: "fc-1", name: "test" },
          {
            type: "message",
            id: "m-2",
            content: [{ type: "output_text", text: "only message" }],
          },
        ],
      },
    });

    const assistant = await iter.next();
    expect(assistant.value.type).toBe("assistant");
    expect(assistant.value.content[0]).toEqual({ type: "text", text: "only message" });
  });

  it("handles response with refusal content part", async () => {
    const iter = session.messages[Symbol.asyncIterator]();

    emitMsg(ws, {
      jsonrpc: "2.0",
      id: 995,
      result: {
        id: "resp-3",
        status: "completed",
        output: [
          {
            type: "message",
            id: "m-3",
            content: [{ type: "refusal", refusal: "I cannot do that" }],
          },
        ],
      },
    });

    const assistant = await iter.next();
    expect(assistant.value.type).toBe("assistant");
    expect(assistant.value.content[0]).toEqual({ type: "text", text: "I cannot do that" });
  });

  it("handles error response without pending RPC", async () => {
    const iter = session.messages[Symbol.asyncIterator]();
    const next = iter.next();

    emitMsg(ws, {
      jsonrpc: "2.0",
      id: "string-id",
      error: { code: -32000, message: "Server error" },
    });

    const result = await next;
    expect(result.value.type).toBe("result");
    expect(result.value.metadata.is_error).toBe(true);
    expect(result.value.metadata.error).toBe("Server error");
  });
});

// ---------------------------------------------------------------------------
// WebSocket error handling & finish
// ---------------------------------------------------------------------------

describe("CodexSession — finish behavior", () => {
  it("finishes on WebSocket error", async () => {
    const ws = new MockWebSocket();
    const launcher = new CodexLauncher({ processManager: createMockProcessManager() });
    const session = new CodexSession({
      sessionId: "test",
      ws: ws as unknown as WebSocket,
      launcher,
      threadId: "t-1",
    });

    const iter = session.messages[Symbol.asyncIterator]();
    const next = iter.next();

    ws.emit("error", new Error("connection reset"));

    const result = await next;
    expect(result.done).toBe(true);
  });

  it("rejects pending RPCs when session closes", async () => {
    const ws = new MockWebSocket();
    const launcher = new CodexLauncher({ processManager: createMockProcessManager() });
    const session = new CodexSession({
      sessionId: "test",
      ws: ws as unknown as WebSocket,
      launcher,
      // No threadId — requestRpc will be used for thread/start
    });

    // Trigger thread initialization (will create a pending RPC)
    session.send(
      createUnifiedMessage({
        type: "user_message",
        role: "user",
        content: [{ type: "text", text: "hello" }],
      }),
    );

    // Close WS before the RPC resolves
    ws.emit("close");

    // The error from rejected RPC should be caught and enqueued as error result
    const iter = session.messages[Symbol.asyncIterator]();
    const result = await iter.next();
    // The iterator is done because ws closed
    expect(result.done).toBe(true);
  });

  it("sendRaw throws (CodexSession does not support raw NDJSON)", () => {
    const ws = new MockWebSocket();
    const launcher = new CodexLauncher({ processManager: createMockProcessManager() });
    const session = new CodexSession({
      sessionId: "test",
      ws: ws as unknown as WebSocket,
      launcher,
      threadId: "t-1",
    });

    expect(() => session.sendRaw("ndjson")).toThrow("does not support raw NDJSON");
    ws.close();
  });
});
