/**
 * CodexAdapter e2e tests — exercises CodexSession directly with MockWebSocket,
 * bypassing the launch+connect+handshake flow.
 */

import { afterEach, describe, expect, it } from "vitest";
import type WebSocket from "ws";
import { CodexLauncher } from "../adapters/codex/codex-launcher.js";
import { CodexSession } from "../adapters/codex/codex-session.js";
import { CodexSlashExecutor } from "../adapters/codex/codex-slash-executor.js";
import type { BackendSession } from "../core/interfaces/backend-adapter.js";
import {
  collectUnifiedMessages,
  createInterruptMessage,
  createMockProcessManager,
  createPermissionResponse,
  createUserMessage,
  MessageReader,
  MockWebSocket,
  sendCodexErrorResponse,
  sendCodexNotification,
  sendCodexRequest,
  sendCodexResponse,
  waitForUnifiedMessageType,
} from "./helpers/backend-test-utils.js";

describe("E2E: CodexAdapter", () => {
  let session: BackendSession | undefined;
  let ws: MockWebSocket;

  function createSession(options?: {
    initResponse?: boolean;
    threadId?: string | null;
  }): CodexSession {
    ws = new MockWebSocket();
    const launcher = new CodexLauncher({
      processManager: createMockProcessManager(),
    });

    const threadId = options?.threadId === null ? undefined : (options?.threadId ?? "thread-test");

    return new CodexSession({
      sessionId: "e2e-codex",
      ws: ws as unknown as WebSocket,
      launcher,
      threadId,
      initResponse:
        options?.initResponse !== false
          ? { capabilities: { streaming: true }, version: "1.0" }
          : undefined,
    });
  }

  /** Allow async microtask chains to settle. */
  function tick(ms = 10): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  /** Find a sent message by JSON-RPC method name. */
  function findSent(method: string): Record<string, unknown> | undefined {
    for (const s of ws.sent) {
      const p = JSON.parse(s);
      if (p.method === method) return p;
    }
    return undefined;
  }

  afterEach(async () => {
    if (session) {
      await session.close();
      session = undefined;
    }
  });

  // -------------------------------------------------------------------------
  // Legacy protocol (existing tests)
  // -------------------------------------------------------------------------

  it("full turn with streaming: text deltas → item done → response.completed", async () => {
    session = createSession();

    // Consume init message
    const { target: initMsg } = await waitForUnifiedMessageType(session, "session_init");
    expect(initMsg.metadata.version).toBe("1.0");

    // Send user message
    session.send(createUserMessage("Hello Codex"));
    expect(ws.sent).toHaveLength(1);

    const sentMsg = JSON.parse(ws.sent[0]);
    expect(sentMsg.method).toBe("turn/start");

    // Simulate streaming response
    sendCodexNotification(ws, "response.output_text.delta", {
      delta: "Hello ",
      output_index: 0,
    });
    sendCodexNotification(ws, "response.output_text.delta", {
      delta: "human!",
      output_index: 0,
    });
    sendCodexNotification(ws, "response.output_item.done", {
      item: {
        type: "message",
        id: "item-1",
        role: "assistant",
        content: [{ type: "output_text", text: "Hello human!" }],
        status: "completed",
      },
    });
    sendCodexNotification(ws, "response.completed", {
      response: {
        id: "resp-1",
        status: "completed",
        output: [{ type: "message", id: "item-1" }],
      },
    });

    // Collect all messages: 2 stream_event deltas + 1 assistant (item done) + 1 result
    const messages = await collectUnifiedMessages(session, 4);

    expect(messages[0].type).toBe("stream_event");
    expect(messages[0].metadata.delta).toBe("Hello ");

    expect(messages[1].type).toBe("stream_event");
    expect(messages[1].metadata.delta).toBe("human!");

    expect(messages[2].type).toBe("assistant");

    expect(messages[3].type).toBe("result");
    expect(messages[3].metadata.status).toBe("completed");
  });

  it("multi-turn: first turn completes, second starts", async () => {
    session = createSession();
    await waitForUnifiedMessageType(session, "session_init");

    // Turn 1
    session.send(createUserMessage("Turn 1"));
    sendCodexNotification(ws, "response.output_text.delta", {
      delta: "Response 1",
      output_index: 0,
    });
    sendCodexNotification(ws, "response.completed", {
      response: { id: "r1", status: "completed", output: [] },
    });

    const turn1 = await collectUnifiedMessages(session, 2);
    expect(turn1[0].type).toBe("stream_event");
    expect(turn1[1].type).toBe("result");

    // Turn 2
    session.send(createUserMessage("Turn 2"));
    expect(ws.sent).toHaveLength(2);

    sendCodexNotification(ws, "response.output_text.delta", {
      delta: "Response 2",
      output_index: 0,
    });
    sendCodexNotification(ws, "response.completed", {
      response: { id: "r2", status: "completed", output: [] },
    });

    const turn2 = await collectUnifiedMessages(session, 2);
    expect(turn2[0].type).toBe("stream_event");
    expect(turn2[0].metadata.delta).toBe("Response 2");
    expect(turn2[1].type).toBe("result");
  });

  it("approval flow → approve → continues", async () => {
    session = createSession();
    await waitForUnifiedMessageType(session, "session_init");

    session.send(createUserMessage("Run a command"));

    // Agent requests approval
    sendCodexNotification(ws, "approval_requested", {
      item: {
        type: "function_call",
        id: "fc-1",
        name: "bash",
        arguments: '{"command":"ls"}',
        call_id: "call-1",
      },
    });

    const { target: permReq } = await waitForUnifiedMessageType(session, "permission_request");
    expect(permReq.metadata.tool_name).toBe("bash");
    expect(permReq.metadata.tool_use_id).toBe("call-1");

    // Approve
    session.send(createPermissionResponse("allow", permReq.id, { request_id: "fc-1" }));

    // Verify approval.respond was sent
    const approvalMsg = ws.sent.find((s) => {
      const p = JSON.parse(s);
      return p.method === "approval.respond";
    });
    expect(approvalMsg).toBeDefined();
    const parsed = JSON.parse(approvalMsg!);
    expect(parsed.params.approve).toBe(true);
  });

  it("approval flow → deny → adjusts", async () => {
    session = createSession();
    await waitForUnifiedMessageType(session, "session_init");

    session.send(createUserMessage("Do dangerous thing"));

    sendCodexNotification(ws, "approval_requested", {
      item: {
        type: "function_call",
        id: "fc-2",
        name: "rm",
        arguments: '{"path":"/etc/passwd"}',
        call_id: "call-2",
      },
    });

    const { target: permReq } = await waitForUnifiedMessageType(session, "permission_request");

    // Deny
    session.send(createPermissionResponse("deny", permReq.id, { request_id: "fc-2" }));

    const denyMsg = ws.sent.find((s) => {
      const p = JSON.parse(s);
      return p.method === "approval.respond";
    });
    expect(denyMsg).toBeDefined();
    const parsed = JSON.parse(denyMsg!);
    expect(parsed.params.approve).toBe(false);
  });

  it("turn cancel (interrupt) sends turn.cancel notification", async () => {
    session = createSession();
    await waitForUnifiedMessageType(session, "session_init");

    session.send(createUserMessage("Start something"));

    // Send interrupt
    session.send(createInterruptMessage());

    const cancelMsg = ws.sent.find((s) => {
      const p = JSON.parse(s);
      return p.method === "turn.cancel";
    });
    expect(cancelMsg).toBeDefined();
    // turn.cancel is a notification (no id)
    const parsed = JSON.parse(cancelMsg!);
    expect(parsed.id).toBeUndefined();
  });

  it("WebSocket close mid-turn ends message stream", async () => {
    session = createSession();
    await waitForUnifiedMessageType(session, "session_init");

    session.send(createUserMessage("Start a turn"));

    // Send partial response then close WebSocket
    sendCodexNotification(ws, "response.output_text.delta", {
      delta: "partial...",
      output_index: 0,
    });

    // Close the WebSocket mid-turn
    ws.emit("close");

    // Should get the partial message before stream ends
    const messages = await collectUnifiedMessages(session, 1, 1000);
    expect(messages[0].type).toBe("stream_event");
    expect(messages[0].metadata.delta).toBe("partial...");
  });

  it("WebSocket error ends message stream", async () => {
    session = createSession();
    await waitForUnifiedMessageType(session, "session_init");

    session.send(createUserMessage("Start"));

    // Emit error
    ws.emit("error", new Error("Connection lost"));

    // Stream should terminate (not hang). The iterator ends when the
    // session detects the error, so next() resolves with done: true.
    const reader = new MessageReader(session);
    await expect(reader.collect(1, 500)).rejects.toThrow(/stream ended early|timed out/);
  });

  it("send after close throws", async () => {
    session = createSession();
    await session.close();

    expect(() => session!.send(createUserMessage("after close"))).toThrow("Session is closed");
    session = undefined; // already closed
  });

  // -------------------------------------------------------------------------
  // v2 protocol: thread/turn lifecycle
  // -------------------------------------------------------------------------

  describe("v2 protocol: thread/turn lifecycle", () => {
    it("initializes thread via thread/start RPC before flushing turns", async () => {
      session = createSession({ threadId: null });
      await waitForUnifiedMessageType(session, "session_init");

      // Send user message — triggers thread initialization
      session.send(createUserMessage("Hello v2"));

      // thread/start should be sent synchronously
      const threadStartReq = findSent("thread/start");
      expect(threadStartReq).toBeDefined();

      // Respond with thread id
      sendCodexResponse(ws, threadStartReq!.id as number, {
        thread: { id: "new-thread-1" },
      });
      await tick();

      // turn/start should now be flushed with the new thread id
      const turnStartReq = findSent("turn/start");
      expect(turnStartReq).toBeDefined();
      expect((turnStartReq!.params as { threadId: string }).threadId).toBe("new-thread-1");
    });

    it("queues multiple messages until thread is initialized", async () => {
      session = createSession({ threadId: null });
      await waitForUnifiedMessageType(session, "session_init");

      // Send two messages before thread is ready
      session.send(createUserMessage("First"));
      session.send(createUserMessage("Second"));

      // Only one thread/start should be sent
      const threadStarts = ws.sent.filter((s) => {
        const p = JSON.parse(s);
        return p.method === "thread/start";
      });
      expect(threadStarts).toHaveLength(1);

      // Respond to thread/start
      const req = JSON.parse(threadStarts[0]);
      sendCodexResponse(ws, req.id, { thread: { id: "t-queue" } });
      await tick();

      // Both queued turns should be flushed
      const turnStarts = ws.sent.filter((s) => {
        const p = JSON.parse(s);
        return p.method === "turn/start";
      });
      expect(turnStarts).toHaveLength(2);
    });

    it("falls back to newConversation when thread/start fails", async () => {
      session = createSession({ threadId: null });
      await waitForUnifiedMessageType(session, "session_init");

      session.send(createUserMessage("Hello fallback"));

      const threadStartReq = findSent("thread/start");
      expect(threadStartReq).toBeDefined();

      // Fail thread/start
      sendCodexErrorResponse(ws, threadStartReq!.id as number, -32601, "method not found");
      await tick();

      // Should fall back to newConversation
      const newConvReq = findSent("newConversation");
      expect(newConvReq).toBeDefined();

      // Respond with legacy conversation id
      sendCodexResponse(ws, newConvReq!.id as number, {
        conversationId: "legacy-conv-1",
      });
      await tick();

      // turn/start should be flushed with the legacy thread id
      const turnStartReq = findSent("turn/start");
      expect(turnStartReq).toBeDefined();
      expect((turnStartReq!.params as { threadId: string }).threadId).toBe("legacy-conv-1");
    });

    it("thread/started notification updates threadId", async () => {
      session = createSession({ threadId: null });
      await waitForUnifiedMessageType(session, "session_init");

      // Simulate server pushing a thread/started notification
      sendCodexNotification(ws, "thread/started", {
        thread: { id: "server-pushed-thread" },
      });

      expect((session as CodexSession).currentThreadId).toBe("server-pushed-thread");
    });

    it("turn/started sets activeTurnId and emits message_start stream event", async () => {
      session = createSession();
      await waitForUnifiedMessageType(session, "session_init");

      session.send(createUserMessage("Hello"));

      // Server sends turn/started notification
      sendCodexNotification(ws, "turn/started", {
        turn: { id: "turn-v2-1" },
      });

      const { target: evt } = await waitForUnifiedMessageType(session, "stream_event");
      expect(evt.metadata.event).toEqual({
        type: "message_start",
        message: {},
      });
    });

    it("turn/completed emits result with completed status", async () => {
      session = createSession();
      await waitForUnifiedMessageType(session, "session_init");

      session.send(createUserMessage("Hello"));

      sendCodexNotification(ws, "turn/completed", {
        turn: { status: "completed" },
      });

      const { target: result } = await waitForUnifiedMessageType(session, "result");
      expect(result.metadata.status).toBe("completed");
      expect(result.metadata.is_error).toBe(false);
    });

    it("turn/completed with failed status emits error result", async () => {
      session = createSession();
      await waitForUnifiedMessageType(session, "session_init");

      session.send(createUserMessage("Hello"));

      sendCodexNotification(ws, "turn/completed", {
        turn: { status: "failed", error: { message: "rate limit exceeded" } },
      });

      const { target: result } = await waitForUnifiedMessageType(session, "result");
      expect(result.metadata.status).toBe("failed");
      expect(result.metadata.is_error).toBe(true);
      expect(result.metadata.error).toBe("rate limit exceeded");
    });
  });

  // -------------------------------------------------------------------------
  // v2 protocol: streaming deltas and item completion
  // -------------------------------------------------------------------------

  describe("v2 protocol: streaming deltas and item completion", () => {
    it("item/agentMessage/delta emits stream_event with content_block_delta", async () => {
      session = createSession();
      await waitForUnifiedMessageType(session, "session_init");

      session.send(createUserMessage("Hello"));

      sendCodexNotification(ws, "item/agentMessage/delta", {
        delta: "Hello from v2!",
      });

      const { target: evt } = await waitForUnifiedMessageType(session, "stream_event");
      expect(evt.metadata.event).toEqual({
        type: "content_block_delta",
        delta: { type: "text_delta", text: "Hello from v2!" },
      });
    });

    it("item/agentMessage/delta ignores empty deltas", async () => {
      session = createSession();
      await waitForUnifiedMessageType(session, "session_init");

      session.send(createUserMessage("Hello"));

      // Empty delta should not produce a message
      sendCodexNotification(ws, "item/agentMessage/delta", { delta: "" });

      // Send a real delta after
      sendCodexNotification(ws, "item/agentMessage/delta", { delta: "real text" });

      const { target: evt } = await waitForUnifiedMessageType(session, "stream_event");
      expect(evt.metadata.event).toEqual({
        type: "content_block_delta",
        delta: { type: "text_delta", text: "real text" },
      });
    });

    it("item/completed with agentMessage emits assistant message", async () => {
      session = createSession();
      await waitForUnifiedMessageType(session, "session_init");

      session.send(createUserMessage("Hello"));

      sendCodexNotification(ws, "item/completed", {
        item: { type: "agentMessage", id: "msg-1", text: "Full response text" },
      });

      const { target: msg } = await waitForUnifiedMessageType(session, "assistant");
      expect(msg.content).toEqual([{ type: "text", text: "Full response text" }]);
      expect(msg.metadata.item_id).toBe("msg-1");
    });

    it("item/completed ignores non-agentMessage items", async () => {
      session = createSession();
      await waitForUnifiedMessageType(session, "session_init");

      session.send(createUserMessage("Hello"));

      // A non-agentMessage item should be ignored
      sendCodexNotification(ws, "item/completed", {
        item: { type: "toolCall", id: "tc-1" },
      });

      // Send a real agentMessage to verify the non-agentMessage was skipped
      sendCodexNotification(ws, "item/completed", {
        item: { type: "agentMessage", id: "msg-2", text: "After tool" },
      });

      const { target: msg } = await waitForUnifiedMessageType(session, "assistant");
      expect(msg.metadata.item_id).toBe("msg-2");
    });

    it("full v2 turn: turn/started → deltas → item/completed → turn/completed", async () => {
      session = createSession();
      await waitForUnifiedMessageType(session, "session_init");

      session.send(createUserMessage("Hello v2 full"));

      // 1. turn/started
      sendCodexNotification(ws, "turn/started", { turn: { id: "tv2-1" } });

      // 2. Streaming deltas
      sendCodexNotification(ws, "item/agentMessage/delta", { delta: "Hello " });
      sendCodexNotification(ws, "item/agentMessage/delta", { delta: "world!" });

      // 3. Item completed
      sendCodexNotification(ws, "item/completed", {
        item: { type: "agentMessage", id: "m-1", text: "Hello world!" },
      });

      // 4. Turn completed
      sendCodexNotification(ws, "turn/completed", {
        turn: { status: "completed" },
      });

      // Collect: message_start + 2 deltas + assistant + result = 5 messages
      const messages = await collectUnifiedMessages(session, 5);

      expect(messages[0].type).toBe("stream_event"); // message_start
      expect(messages[1].type).toBe("stream_event"); // delta "Hello "
      expect(messages[2].type).toBe("stream_event"); // delta "world!"
      expect(messages[3].type).toBe("assistant");
      expect(messages[3].content).toEqual([{ type: "text", text: "Hello world!" }]);
      expect(messages[4].type).toBe("result");
      expect(messages[4].metadata.status).toBe("completed");
    });
  });

  // -------------------------------------------------------------------------
  // v2 protocol: server-request approvals
  // -------------------------------------------------------------------------

  describe("v2 protocol: server-request approvals", () => {
    it("item/commandExecution/requestApproval → approve responds with accept decision", async () => {
      session = createSession();
      await waitForUnifiedMessageType(session, "session_init");

      session.send(createUserMessage("Run a command"));

      // Server sends a JSON-RPC request (has an id) for approval
      sendCodexRequest(ws, 100, "item/commandExecution/requestApproval", {
        command: "ls -la",
      });

      const { target: permReq } = await waitForUnifiedMessageType(session, "permission_request");
      expect(permReq.metadata.tool_name).toBe("item/commandExecution/requestApproval");
      expect(permReq.metadata.request_id).toBe("100");

      // Approve
      session.send(createPermissionResponse("allow", permReq.id, { request_id: "100" }));

      // Verify the response sent back
      const responseSent = ws.sent.find((s) => {
        const p = JSON.parse(s);
        return p.id === 100 && p.result;
      });
      expect(responseSent).toBeDefined();
      const parsed = JSON.parse(responseSent!);
      expect(parsed.result.decision).toBe("accept");
    });

    it("item/fileChange/requestApproval → deny responds with decline decision", async () => {
      session = createSession();
      await waitForUnifiedMessageType(session, "session_init");

      session.send(createUserMessage("Modify a file"));

      sendCodexRequest(ws, 101, "item/fileChange/requestApproval", {
        path: "/etc/hosts",
      });

      const { target: permReq } = await waitForUnifiedMessageType(session, "permission_request");
      expect(permReq.metadata.tool_name).toBe("item/fileChange/requestApproval");

      // Deny
      session.send(createPermissionResponse("deny", permReq.id, { request_id: "101" }));

      const responseSent = ws.sent.find((s) => {
        const p = JSON.parse(s);
        return p.id === 101 && p.result;
      });
      expect(responseSent).toBeDefined();
      const parsed = JSON.parse(responseSent!);
      expect(parsed.result.decision).toBe("decline");
    });

    it("execCommandApproval → approve responds with approved decision", async () => {
      session = createSession();
      await waitForUnifiedMessageType(session, "session_init");

      session.send(createUserMessage("Execute something"));

      sendCodexRequest(ws, 102, "execCommandApproval", {
        command: "npm test",
      });

      const { target: permReq } = await waitForUnifiedMessageType(session, "permission_request");

      // Approve
      session.send(createPermissionResponse("allow", permReq.id, { request_id: "102" }));

      const responseSent = ws.sent.find((s) => {
        const p = JSON.parse(s);
        return p.id === 102 && p.result;
      });
      expect(responseSent).toBeDefined();
      const parsed = JSON.parse(responseSent!);
      expect(parsed.result.decision).toBe("approved");
    });

    it("applyPatchApproval → deny responds with denied decision", async () => {
      session = createSession();
      await waitForUnifiedMessageType(session, "session_init");

      session.send(createUserMessage("Apply patch"));

      sendCodexRequest(ws, 103, "applyPatchApproval", {
        patch: "diff --git a/foo b/foo",
      });

      const { target: permReq } = await waitForUnifiedMessageType(session, "permission_request");

      // Deny
      session.send(createPermissionResponse("deny", permReq.id, { request_id: "103" }));

      const responseSent = ws.sent.find((s) => {
        const p = JSON.parse(s);
        return p.id === 103 && p.result;
      });
      expect(responseSent).toBeDefined();
      const parsed = JSON.parse(responseSent!);
      expect(parsed.result.decision).toBe("denied");
    });

    it("unsupported server request responds with error", async () => {
      session = createSession();
      await waitForUnifiedMessageType(session, "session_init");

      sendCodexRequest(ws, 200, "unknown/method", {});

      // Should respond with JSON-RPC error
      const errorResp = ws.sent.find((s) => {
        const p = JSON.parse(s);
        return p.id === 200 && p.error;
      });
      expect(errorResp).toBeDefined();
      const parsed = JSON.parse(errorResp!);
      expect(parsed.error.message).toContain("Unsupported server request method");
    });
  });

  // -------------------------------------------------------------------------
  // v2 protocol: turn interrupt
  // -------------------------------------------------------------------------

  describe("v2 protocol: turn interrupt", () => {
    it("interrupt sends turn/interrupt RPC when threadId and turnId are set", async () => {
      session = createSession(); // has threadId = "thread-test"
      await waitForUnifiedMessageType(session, "session_init");

      session.send(createUserMessage("Start a task"));

      // Simulate turn/started to set activeTurnId
      sendCodexNotification(ws, "turn/started", { turn: { id: "active-turn-1" } });
      await tick();

      // Send interrupt
      session.send(createInterruptMessage());

      const interruptReq = findSent("turn/interrupt");
      expect(interruptReq).toBeDefined();
      expect((interruptReq!.params as { threadId: string }).threadId).toBe("thread-test");
      expect((interruptReq!.params as { turnId: string }).turnId).toBe("active-turn-1");
    });

    it("interrupt falls back to turn.cancel when no activeTurnId", async () => {
      session = createSession();
      await waitForUnifiedMessageType(session, "session_init");

      session.send(createUserMessage("Start"));

      // No turn/started notification → no activeTurnId
      session.send(createInterruptMessage());

      const cancelMsg = findSent("turn.cancel");
      expect(cancelMsg).toBeDefined();
      // turn.cancel is a notification (no id)
      expect(cancelMsg!.id).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Thread reset
  // -------------------------------------------------------------------------

  describe("thread reset", () => {
    it("resetThread creates a new thread", async () => {
      const codexSession = createSession();
      session = codexSession;
      await waitForUnifiedMessageType(session, "session_init");

      expect(codexSession.currentThreadId).toBe("thread-test");

      // Start a turn to set activeTurnId
      sendCodexNotification(ws, "turn/started", { turn: { id: "old-turn" } });
      await tick();

      // Reset the thread
      const resetPromise = codexSession.resetThread();

      // Should send thread/start
      await tick();
      const threadStartReq = findSent("thread/start");
      expect(threadStartReq).toBeDefined();

      // Respond with new thread
      sendCodexResponse(ws, threadStartReq!.id as number, {
        thread: { id: "fresh-thread" },
      });

      const newThreadId = await resetPromise;
      expect(newThreadId).toBe("fresh-thread");
      expect(codexSession.currentThreadId).toBe("fresh-thread");
    });
  });

  // -------------------------------------------------------------------------
  // Response-based output (non-notification path)
  // -------------------------------------------------------------------------

  describe("response-based output", () => {
    it("RPC response with output items emits assistant messages + result", async () => {
      session = createSession();
      await waitForUnifiedMessageType(session, "session_init");

      session.send(createUserMessage("Hello"));

      // Get the turn/start request id
      const turnReq = findSent("turn/start");
      expect(turnReq).toBeDefined();

      // Respond with output items (some Codex builds return output via response)
      sendCodexResponse(ws, turnReq!.id as number, {
        response: {
          id: "resp-via-rpc",
          status: "completed",
          output: [
            {
              type: "message",
              id: "m-1",
              role: "assistant",
              content: [{ type: "output_text", text: "Response via RPC" }],
              status: "completed",
            },
          ],
        },
      });

      const messages = await collectUnifiedMessages(session, 2);
      expect(messages[0].type).toBe("assistant");
      expect(messages[0].content).toEqual([{ type: "text", text: "Response via RPC" }]);
      expect(messages[0].metadata.item_id).toBe("m-1");

      expect(messages[1].type).toBe("result");
      expect(messages[1].metadata.status).toBe("completed");
      expect(messages[1].metadata.response_id).toBe("resp-via-rpc");
      expect(messages[1].metadata.output_items).toBe(1);
    });

    it("RPC response with output_text emits assistant + result", async () => {
      session = createSession();
      await waitForUnifiedMessageType(session, "session_init");

      session.send(createUserMessage("Hello"));

      const turnReq = findSent("turn/start");
      expect(turnReq).toBeDefined();

      // Respond with simple output_text format
      sendCodexResponse(ws, turnReq!.id as number, {
        output_text: "Simple text response",
      });

      const messages = await collectUnifiedMessages(session, 2);
      expect(messages[0].type).toBe("assistant");
      expect(messages[0].content).toEqual([{ type: "text", text: "Simple text response" }]);

      expect(messages[1].type).toBe("result");
      expect(messages[1].metadata.status).toBe("completed");
    });

    it("RPC response with empty output_text emits only result", async () => {
      session = createSession();
      await waitForUnifiedMessageType(session, "session_init");

      session.send(createUserMessage("Hello"));

      const turnReq = findSent("turn/start");
      expect(turnReq).toBeDefined();

      sendCodexResponse(ws, turnReq!.id as number, {
        output_text: "",
      });

      const messages = await collectUnifiedMessages(session, 1);
      expect(messages[0].type).toBe("result");
      expect(messages[0].metadata.status).toBe("completed");
    });
  });

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------

  describe("error handling", () => {
    it("error notification emits error result", async () => {
      session = createSession();
      await waitForUnifiedMessageType(session, "session_init");

      sendCodexNotification(ws, "error", {
        error: { message: "Internal backend error" },
      });

      const { target: result } = await waitForUnifiedMessageType(session, "result");
      expect(result.metadata.status).toBe("failed");
      expect(result.metadata.is_error).toBe(true);
      expect(result.metadata.error).toBe("Internal backend error");
    });

    it("error notification without message uses fallback", async () => {
      session = createSession();
      await waitForUnifiedMessageType(session, "session_init");

      sendCodexNotification(ws, "error", { error: {} });

      const { target: result } = await waitForUnifiedMessageType(session, "result");
      expect(result.metadata.error).toBe("Codex backend error");
    });

    it("response.failed event emits error result", async () => {
      session = createSession();
      await waitForUnifiedMessageType(session, "session_init");

      session.send(createUserMessage("Fail"));

      sendCodexNotification(ws, "response.failed", {
        response: { id: "fail-1", status: "rate_limited" },
      });

      const { target: result } = await waitForUnifiedMessageType(session, "result");
      expect(result.metadata.status).toBe("failed");
      expect(result.metadata.is_error).toBe(true);
      expect(result.metadata.response_id).toBe("fail-1");
      expect(result.metadata.error).toBe("rate_limited");
    });

    it("thread init failure emits error result for queued turns", async () => {
      session = createSession({ threadId: null });
      await waitForUnifiedMessageType(session, "session_init");

      session.send(createUserMessage("Hello"));

      const threadStartReq = findSent("thread/start");
      expect(threadStartReq).toBeDefined();

      // Fail thread/start
      sendCodexErrorResponse(ws, threadStartReq!.id as number, -32603, "thread start failed");
      await tick();

      // Should also fail newConversation
      const newConvReq = findSent("newConversation");
      expect(newConvReq).toBeDefined();
      sendCodexErrorResponse(ws, newConvReq!.id as number, -32603, "legacy also failed");
      await tick();

      // Session should emit an error result
      const { target: result } = await waitForUnifiedMessageType(session, "result", 2000);
      expect(result.metadata.is_error).toBe(true);
      expect(result.metadata.status).toBe("failed");
    });

    it("RPC error response emits error result", async () => {
      session = createSession();
      await waitForUnifiedMessageType(session, "session_init");

      session.send(createUserMessage("Hello"));

      const turnReq = findSent("turn/start");
      expect(turnReq).toBeDefined();

      // Send error response for the turn/start
      sendCodexErrorResponse(ws, turnReq!.id as number, -32000, "Server overloaded");

      const { target: result } = await waitForUnifiedMessageType(session, "result");
      expect(result.metadata.status).toBe("failed");
      expect(result.metadata.is_error).toBe(true);
      expect(result.metadata.error).toBe("Server overloaded");
    });

    it("codex/event/error (legacy wrapped) emits error result with error_code", async () => {
      session = createSession();
      await waitForUnifiedMessageType(session, "session_init");

      sendCodexNotification(ws, "codex/event/error", {
        id: "turn-1",
        msg: {
          type: "error",
          message: "You've hit your usage limit.",
          codex_error_info: "usage_limit_exceeded",
        },
        conversationId: "conv-1",
      });

      const { target: result } = await waitForUnifiedMessageType(session, "result");
      expect(result.metadata.status).toBe("failed");
      expect(result.metadata.is_error).toBe(true);
      expect(result.metadata.error).toBe("You've hit your usage limit.");
      expect(result.metadata.error_code).toBe("usage_limit_exceeded");
    });

    it("v2 error notification includes error_code from codexErrorInfo", async () => {
      session = createSession();
      await waitForUnifiedMessageType(session, "session_init");

      sendCodexNotification(ws, "error", {
        error: {
          message: "Rate limited",
          codexErrorInfo: "usageLimitExceeded",
        },
        willRetry: false,
      });

      const { target: result } = await waitForUnifiedMessageType(session, "result");
      expect(result.metadata.status).toBe("failed");
      expect(result.metadata.is_error).toBe(true);
      expect(result.metadata.error).toBe("Rate limited");
      expect(result.metadata.error_code).toBe("usageLimitExceeded");
    });
  });

  // -------------------------------------------------------------------------
  // Tool events (legacy protocol events for function_call items)
  // -------------------------------------------------------------------------

  describe("tool events", () => {
    it("function_call item added emits tool_progress", async () => {
      session = createSession();
      await waitForUnifiedMessageType(session, "session_init");

      session.send(createUserMessage("Run tool"));

      sendCodexNotification(ws, "response.output_item.added", {
        item: {
          type: "function_call",
          id: "fc-add-1",
          name: "bash",
          arguments: '{"command":"ls"}',
          call_id: "call-add-1",
          status: "in_progress",
        },
        output_index: 1,
      });

      const { target: msg } = await waitForUnifiedMessageType(session, "tool_progress");
      expect(msg.metadata.name).toBe("bash");
      expect(msg.metadata.tool_use_id).toBe("call-add-1");
      expect(msg.metadata.status).toBe("in_progress");
    });

    it("function_call item done emits tool_progress with completed status", async () => {
      session = createSession();
      await waitForUnifiedMessageType(session, "session_init");

      session.send(createUserMessage("Run tool"));

      sendCodexNotification(ws, "response.output_item.done", {
        item: {
          type: "function_call",
          id: "fc-done-1",
          name: "bash",
          arguments: '{"command":"ls"}',
          call_id: "call-done-1",
          status: "completed",
        },
        output_index: 1,
      });

      const { target: msg } = await waitForUnifiedMessageType(session, "tool_progress");
      expect(msg.metadata.name).toBe("bash");
      expect(msg.metadata.status).toBe("completed");
    });

    it("function_call_output item done emits tool_use_summary", async () => {
      session = createSession();
      await waitForUnifiedMessageType(session, "session_init");

      session.send(createUserMessage("Run tool"));

      sendCodexNotification(ws, "response.output_item.done", {
        item: {
          type: "function_call_output",
          id: "fco-1",
          call_id: "call-out-1",
          output: "file1.txt\nfile2.txt",
          status: "completed",
        },
        output_index: 2,
      });

      const { target: msg } = await waitForUnifiedMessageType(session, "tool_use_summary");
      expect(msg.metadata.output).toBe("file1.txt\nfile2.txt");
      expect(msg.metadata.tool_use_id).toBe("call-out-1");
      expect(msg.metadata.status).toBe("completed");
    });

    it("message item added emits assistant message", async () => {
      session = createSession();
      await waitForUnifiedMessageType(session, "session_init");

      session.send(createUserMessage("Hello"));

      sendCodexNotification(ws, "response.output_item.added", {
        item: {
          type: "message",
          id: "msg-add-1",
          role: "assistant",
          content: [{ type: "output_text", text: "Starting..." }],
          status: "in_progress",
        },
        output_index: 0,
      });

      const { target: msg } = await waitForUnifiedMessageType(session, "assistant");
      expect(msg.content).toEqual([{ type: "text", text: "Starting..." }]);
      expect(msg.metadata.status).toBe("in_progress");
    });
  });

  // -------------------------------------------------------------------------
  // Refusal handling
  // -------------------------------------------------------------------------

  describe("refusal handling", () => {
    it("item with refusal content emits assistant message with refusal prefix", async () => {
      session = createSession();
      await waitForUnifiedMessageType(session, "session_init");

      session.send(createUserMessage("Do something bad"));

      sendCodexNotification(ws, "response.output_item.done", {
        item: {
          type: "message",
          id: "ref-1",
          role: "assistant",
          content: [{ type: "refusal", refusal: "I cannot help with that." }],
          status: "completed",
        },
      });

      const { target: msg } = await waitForUnifiedMessageType(session, "assistant");
      expect(msg.content).toEqual([{ type: "refusal", refusal: "I cannot help with that." }]);
    });

    it("mixed content with text and refusal", async () => {
      session = createSession();
      await waitForUnifiedMessageType(session, "session_init");

      session.send(createUserMessage("Multi content"));

      sendCodexNotification(ws, "response.output_item.done", {
        item: {
          type: "message",
          id: "mix-1",
          role: "assistant",
          content: [
            { type: "output_text", text: "Here is some context. " },
            { type: "refusal", refusal: "But I cannot do that part." },
          ],
          status: "completed",
        },
      });

      const { target: msg } = await waitForUnifiedMessageType(session, "assistant");
      expect(msg.content).toHaveLength(2);
      expect(msg.content[0]).toEqual({ type: "text", text: "Here is some context. " });
      expect(msg.content[1]).toEqual({
        type: "refusal",
        refusal: "But I cannot do that part.",
      });
    });
  });

  // -------------------------------------------------------------------------
  // Slash command integration (CodexSlashExecutor through CodexSession)
  // -------------------------------------------------------------------------

  describe("slash command integration", () => {
    it("/compact sends thread/compact/start RPC", async () => {
      const codexSession = createSession();
      session = codexSession;
      await waitForUnifiedMessageType(session, "session_init");

      const executor = new CodexSlashExecutor(codexSession);
      expect(executor.handles("/compact")).toBe(true);

      const execPromise = executor.execute("/compact");

      await tick();
      const compactReq = findSent("thread/compact/start");
      expect(compactReq).toBeDefined();
      expect((compactReq!.params as { threadId: string }).threadId).toBe("thread-test");

      // Respond with success
      sendCodexResponse(ws, compactReq!.id as number, { status: "ok" });

      const result = await execPromise;
      expect(result).not.toBeNull();
      expect(result!.content).toBe("Compaction started.");
      expect(result!.source).toBe("emulated");
    });

    it("/new resets thread and starts fresh", async () => {
      const codexSession = createSession();
      session = codexSession;
      await waitForUnifiedMessageType(session, "session_init");

      expect(codexSession.currentThreadId).toBe("thread-test");

      const executor = new CodexSlashExecutor(codexSession);
      const execPromise = executor.execute("/new");

      await tick();
      const threadStartReq = findSent("thread/start");
      expect(threadStartReq).toBeDefined();

      sendCodexResponse(ws, threadStartReq!.id as number, {
        thread: { id: "new-thread-via-slash" },
      });

      const result = await execPromise;
      expect(result).not.toBeNull();
      expect(result!.content).toBe("New thread started: new-thread-via-slash");
      expect(codexSession.currentThreadId).toBe("new-thread-via-slash");
    });

    it("/review sends review/start RPC", async () => {
      const codexSession = createSession();
      session = codexSession;
      await waitForUnifiedMessageType(session, "session_init");

      const executor = new CodexSlashExecutor(codexSession);
      const execPromise = executor.execute("/review");

      await tick();
      const reviewReq = findSent("review/start");
      expect(reviewReq).toBeDefined();
      expect((reviewReq!.params as { threadId: string }).threadId).toBe("thread-test");

      sendCodexResponse(ws, reviewReq!.id as number, {});

      const result = await execPromise;
      expect(result).not.toBeNull();
      expect(result!.content).toBe("Review started.");
    });

    it("/rename sends thread/name/set with new name", async () => {
      const codexSession = createSession();
      session = codexSession;
      await waitForUnifiedMessageType(session, "session_init");

      const executor = new CodexSlashExecutor(codexSession);
      const execPromise = executor.execute("/rename My Great Thread");

      await tick();
      const renameReq = findSent("thread/name/set");
      expect(renameReq).toBeDefined();
      expect((renameReq!.params as { threadId: string; name: string }).threadId).toBe(
        "thread-test",
      );
      expect((renameReq!.params as { name: string }).name).toBe("My Great Thread");

      sendCodexResponse(ws, renameReq!.id as number, {});

      const result = await execPromise;
      expect(result).not.toBeNull();
      expect(result!.content).toBe("Thread renamed to: My Great Thread");
    });

    it("/rename without args throws", async () => {
      const codexSession = createSession();
      session = codexSession;
      await waitForUnifiedMessageType(session, "session_init");

      const executor = new CodexSlashExecutor(codexSession);
      await expect(executor.execute("/rename")).rejects.toThrow("Usage: /rename <name>");
    });

    it("unsupported command returns null", async () => {
      const codexSession = createSession();
      session = codexSession;
      await waitForUnifiedMessageType(session, "session_init");

      const executor = new CodexSlashExecutor(codexSession);
      expect(executor.handles("/unknown")).toBe(false);
      const result = await executor.execute("/unknown");
      expect(result).toBeNull();
    });

    it("/compact on unsupported server returns error content", async () => {
      const codexSession = createSession();
      session = codexSession;
      await waitForUnifiedMessageType(session, "session_init");

      const executor = new CodexSlashExecutor(codexSession);
      const execPromise = executor.execute("/compact");

      await tick();
      const compactReq = findSent("thread/compact/start");
      expect(compactReq).toBeDefined();

      // Server responds with method-not-found (JSON-RPC error in result)
      sendCodexErrorResponse(ws, compactReq!.id as number, -32601, "method not found");

      // requestRpc resolves (not rejects) with error response;
      // formatResponse extracts the error message
      const result = await execPromise;
      expect(result).not.toBeNull();
      expect(result!.content).toBe("Error: method not found");
    });

    it("/compact with error response returns error content", async () => {
      const codexSession = createSession();
      session = codexSession;
      await waitForUnifiedMessageType(session, "session_init");

      const executor = new CodexSlashExecutor(codexSession);
      const execPromise = executor.execute("/compact");

      await tick();
      const compactReq = findSent("thread/compact/start");
      expect(compactReq).toBeDefined();

      // Respond with RPC-level error in the result
      sendCodexResponse(ws, compactReq!.id as number, undefined);

      const result = await execPromise;
      expect(result).not.toBeNull();
      // formatResponse returns fallback when no error in resp
      expect(result!.content).toBe("Compaction started.");
    });

    it("slash commands require an active thread", async () => {
      const codexSession = createSession({ threadId: null });
      session = codexSession;
      await waitForUnifiedMessageType(session, "session_init");

      const executor = new CodexSlashExecutor(codexSession);
      await expect(executor.execute("/compact")).rejects.toThrow("No active thread");
    });

    it("supportedCommands returns all slash commands", async () => {
      const codexSession = createSession();
      session = codexSession;

      const executor = new CodexSlashExecutor(codexSession);
      const commands = executor.supportedCommands();
      expect(commands).toContain("/compact");
      expect(commands).toContain("/new");
      expect(commands).toContain("/review");
      expect(commands).toContain("/rename");
    });
  });

  // -------------------------------------------------------------------------
  // State transition edge cases
  // -------------------------------------------------------------------------

  describe("state transition edge cases", () => {
    it("turn/completed clears activeTurnId, next interrupt uses turn.cancel", async () => {
      session = createSession();
      await waitForUnifiedMessageType(session, "session_init");

      session.send(createUserMessage("Hello"));

      // Set active turn
      sendCodexNotification(ws, "turn/started", { turn: { id: "turn-A" } });
      await tick();

      // Complete turn (clears activeTurnId)
      sendCodexNotification(ws, "turn/completed", { turn: { status: "completed" } });
      await collectUnifiedMessages(session, 2); // message_start + result

      // Now interrupt should use legacy turn.cancel since no active turn
      session.send(createInterruptMessage());
      const cancelMsg = findSent("turn.cancel");
      expect(cancelMsg).toBeDefined();
      expect(findSent("turn/interrupt")).toBeUndefined();
    });

    it("multiple concurrent approval requests and responses", async () => {
      session = createSession();
      await waitForUnifiedMessageType(session, "session_init");

      session.send(createUserMessage("Do multiple things"));

      // Server sends two approval requests
      sendCodexRequest(ws, 300, "item/commandExecution/requestApproval", {
        command: "ls",
      });
      sendCodexRequest(ws, 301, "item/fileChange/requestApproval", {
        path: "/tmp/test.txt",
      });

      // Collect both permission requests
      const msgs = await collectUnifiedMessages(session, 2);
      expect(msgs[0].type).toBe("permission_request");
      expect(msgs[0].metadata.request_id).toBe("300");
      expect(msgs[1].type).toBe("permission_request");
      expect(msgs[1].metadata.request_id).toBe("301");

      // Approve first, deny second
      session.send(createPermissionResponse("allow", msgs[0].id, { request_id: "300" }));
      session.send(createPermissionResponse("deny", msgs[1].id, { request_id: "301" }));

      // Verify correct decisions
      const resp300 = ws.sent.find((s) => {
        const p = JSON.parse(s);
        return p.id === 300 && p.result;
      });
      expect(resp300).toBeDefined();
      expect(JSON.parse(resp300!).result.decision).toBe("accept");

      const resp301 = ws.sent.find((s) => {
        const p = JSON.parse(s);
        return p.id === 301 && p.result;
      });
      expect(resp301).toBeDefined();
      expect(JSON.parse(resp301!).result.decision).toBe("decline");
    });

    it("resetThread during active turn interrupts first", async () => {
      const codexSession = createSession();
      session = codexSession;
      await waitForUnifiedMessageType(session, "session_init");

      session.send(createUserMessage("Start task"));

      // Set active turn
      sendCodexNotification(ws, "turn/started", { turn: { id: "active-reset" } });
      await tick();

      // Reset (should interrupt first)
      const resetPromise = codexSession.resetThread();

      await tick();

      // Verify turn/interrupt was sent before thread/start
      const interruptReq = findSent("turn/interrupt");
      expect(interruptReq).toBeDefined();
      expect((interruptReq!.params as { turnId: string }).turnId).toBe("active-reset");

      const threadStartReq = findSent("thread/start");
      expect(threadStartReq).toBeDefined();

      sendCodexResponse(ws, threadStartReq!.id as number, {
        thread: { id: "after-reset-thread" },
      });

      const newThreadId = await resetPromise;
      expect(newThreadId).toBe("after-reset-thread");
    });

    it("turn response updates threadId and turnId from result", async () => {
      session = createSession();
      await waitForUnifiedMessageType(session, "session_init");

      session.send(createUserMessage("Hello"));

      const turnReq = findSent("turn/start");
      expect(turnReq).toBeDefined();

      // Response includes thread and turn IDs in result
      sendCodexResponse(ws, turnReq!.id as number, {
        thread: { id: "updated-thread" },
        turn: { id: "updated-turn" },
      });

      await tick();

      // Now interrupt should use the updated IDs
      session.send(createInterruptMessage());

      const interruptReq = findSent("turn/interrupt");
      expect(interruptReq).toBeDefined();
      expect((interruptReq!.params as { threadId: string }).threadId).toBe("updated-thread");
      expect((interruptReq!.params as { turnId: string }).turnId).toBe("updated-turn");
    });

    it("thread/started notification mid-turn updates threadId", async () => {
      session = createSession({ threadId: null });
      await waitForUnifiedMessageType(session, "session_init");

      // Server pushes thread/started before we send anything
      sendCodexNotification(ws, "thread/started", {
        thread: { id: "server-set-thread" },
      });

      // Now sending a message should use the server-set threadId directly
      session.send(createUserMessage("Hello"));

      const turnReq = findSent("turn/start");
      expect(turnReq).toBeDefined();
      expect((turnReq!.params as { threadId: string }).threadId).toBe("server-set-thread");
    });
  });

  // -------------------------------------------------------------------------
  // Robustness (malformed messages, close behavior)
  // -------------------------------------------------------------------------

  describe("robustness", () => {
    it("non-JSON WebSocket message is silently ignored", async () => {
      session = createSession();
      await waitForUnifiedMessageType(session, "session_init");

      // Send garbage
      ws.emit("message", Buffer.from("this is not json {{{"));

      // Should not crash — verify by successfully sending a real message
      session.send(createUserMessage("After garbage"));
      const turnReq = findSent("turn/start");
      expect(turnReq).toBeDefined();
    });

    it("JSON-RPC message with no method and no matching id is ignored", async () => {
      session = createSession();
      await waitForUnifiedMessageType(session, "session_init");

      // A response with an id that doesn't match any pending RPC and no error
      ws.emit("message", Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 99999, result: {} })));

      // Should not crash
      session.send(createUserMessage("After orphan"));
      expect(findSent("turn/start")).toBeDefined();
    });

    it("close() is idempotent", async () => {
      session = createSession();
      await waitForUnifiedMessageType(session, "session_init");

      await session.close();
      // Second close should not throw
      await session.close();
      session = undefined; // already closed
    });

    it("send after close throws consistently", async () => {
      session = createSession();
      await session.close();

      expect(() => session!.send(createUserMessage("first attempt"))).toThrow("Session is closed");
      expect(() => session!.send(createUserMessage("second attempt"))).toThrow("Session is closed");
      session = undefined;
    });

    it("sendRaw throws (not supported)", async () => {
      session = createSession();
      expect(() => session!.sendRaw("raw ndjson data")).toThrow("does not support raw NDJSON");
    });

    it("notification with no params defaults to empty object", async () => {
      session = createSession();
      await waitForUnifiedMessageType(session, "session_init");

      // turn/completed with no params should default gracefully
      ws.emit("message", Buffer.from(JSON.stringify({ jsonrpc: "2.0", method: "turn/completed" })));

      const { target: result } = await waitForUnifiedMessageType(session, "result");
      expect(result.metadata.status).toBe("completed");
    });

    it("error notification with non-string message uses fallback", async () => {
      session = createSession();
      await waitForUnifiedMessageType(session, "session_init");

      sendCodexNotification(ws, "error", { error: { message: 12345 } });

      const { target: result } = await waitForUnifiedMessageType(session, "result");
      expect(result.metadata.error).toBe("Codex backend error");
    });
  });

  // -------------------------------------------------------------------------
  // Response edge cases
  // -------------------------------------------------------------------------

  describe("response edge cases", () => {
    it("response with output array containing only non-message items emits result only", async () => {
      session = createSession();
      await waitForUnifiedMessageType(session, "session_init");

      session.send(createUserMessage("Hello"));

      const turnReq = findSent("turn/start");
      expect(turnReq).toBeDefined();

      sendCodexResponse(ws, turnReq!.id as number, {
        id: "resp-non-msg",
        status: "completed",
        output: [
          { type: "function_call", id: "fc-1", name: "test" },
          { type: "function_call_output", id: "fco-1", output: "output" },
        ],
      });

      const messages = await collectUnifiedMessages(session, 3);
      expect(messages[0].type).toBe("tool_progress");
      expect(messages[1].type).toBe("tool_use_summary");
      expect(messages[2].type).toBe("result");
      expect(messages[2].metadata.output_items).toBe(2);
    });

    it("response with empty output array emits result", async () => {
      session = createSession();
      await waitForUnifiedMessageType(session, "session_init");

      session.send(createUserMessage("Hello"));

      const turnReq = findSent("turn/start");
      expect(turnReq).toBeDefined();

      sendCodexResponse(ws, turnReq!.id as number, {
        id: "resp-empty",
        status: "completed",
        output: [],
      });

      const messages = await collectUnifiedMessages(session, 1);
      expect(messages[0].type).toBe("result");
      expect(messages[0].metadata.output_items).toBe(0);
    });

    it("response with message item with empty content array produces no assistant text", async () => {
      session = createSession();
      await waitForUnifiedMessageType(session, "session_init");

      session.send(createUserMessage("Hello"));

      const turnReq = findSent("turn/start");
      expect(turnReq).toBeDefined();

      sendCodexResponse(ws, turnReq!.id as number, {
        id: "resp-empty-content",
        status: "completed",
        output: [{ type: "message", id: "m-empty", content: [], status: "completed" }],
      });

      // Empty text → no assistant message enqueued, just result
      const messages = await collectUnifiedMessages(session, 1);
      expect(messages[0].type).toBe("result");
    });

    it("response with message item with unknown content type is ignored", async () => {
      session = createSession();
      await waitForUnifiedMessageType(session, "session_init");

      session.send(createUserMessage("Hello"));

      const turnReq = findSent("turn/start");
      expect(turnReq).toBeDefined();

      sendCodexResponse(ws, turnReq!.id as number, {
        id: "resp-unknown-type",
        status: "completed",
        output: [
          {
            type: "message",
            id: "m-unknown",
            content: [{ type: "image", url: "https://example.com/img.png" }],
            status: "completed",
          },
        ],
      });

      // Unknown content type produces no text → no assistant message
      const messages = await collectUnifiedMessages(session, 1);
      expect(messages[0].type).toBe("result");
    });

    it("wrapped event notification format (params.type) is handled", async () => {
      session = createSession();
      await waitForUnifiedMessageType(session, "session_init");

      session.send(createUserMessage("Hello"));

      // Some Codex builds send { method: "event", params: { type: "response.completed", ... } }
      sendCodexNotification(ws, "event", {
        type: "response.completed",
        response: { id: "wrapped-resp", status: "completed", output: [] },
      });

      const { target: result } = await waitForUnifiedMessageType(session, "result");
      expect(result.metadata.status).toBe("completed");
      expect(result.metadata.response_id).toBe("wrapped-resp");
    });

    it("response with multiple message items emits all of them", async () => {
      session = createSession();
      await waitForUnifiedMessageType(session, "session_init");

      session.send(createUserMessage("Hello"));

      const turnReq = findSent("turn/start");
      expect(turnReq).toBeDefined();

      sendCodexResponse(ws, turnReq!.id as number, {
        id: "resp-multi",
        status: "completed",
        output: [
          {
            type: "message",
            id: "m-1",
            content: [{ type: "output_text", text: "First message" }],
            status: "completed",
          },
          {
            type: "message",
            id: "m-2",
            content: [{ type: "output_text", text: "Second message" }],
            status: "completed",
          },
        ],
      });

      const messages = await collectUnifiedMessages(session, 3);
      expect(messages[0].type).toBe("assistant");
      expect(messages[0].content).toEqual([{ type: "text", text: "First message" }]);
      expect(messages[0].metadata.item_id).toBe("m-1");

      expect(messages[1].type).toBe("assistant");
      expect(messages[1].content).toEqual([{ type: "text", text: "Second message" }]);
      expect(messages[1].metadata.item_id).toBe("m-2");

      expect(messages[2].type).toBe("result");
      expect(messages[2].metadata.output_items).toBe(2);
    });

    it("response with mixed text and refusal content in output items", async () => {
      session = createSession();
      await waitForUnifiedMessageType(session, "session_init");

      session.send(createUserMessage("Hello"));

      const turnReq = findSent("turn/start");
      expect(turnReq).toBeDefined();

      sendCodexResponse(ws, turnReq!.id as number, {
        id: "resp-mixed",
        status: "completed",
        output: [
          {
            type: "message",
            id: "m-mix",
            content: [
              { type: "output_text", text: "Here is some context." },
              { type: "refusal", refusal: "Cannot do that part." },
            ],
            status: "completed",
          },
        ],
      });

      const messages = await collectUnifiedMessages(session, 2);
      expect(messages[0].type).toBe("assistant");
      expect(messages[0].content[0].text).toBe("Here is some context.\nCannot do that part.");
      expect(messages[1].type).toBe("result");
    });

    it("error response from non-pending RPC emits error result", async () => {
      session = createSession();
      await waitForUnifiedMessageType(session, "session_init");

      // An error response that doesn't match any pending RPC
      ws.emit(
        "message",
        Buffer.from(
          JSON.stringify({
            jsonrpc: "2.0",
            id: "orphan-id",
            error: { code: -32000, message: "Unexpected error" },
          }),
        ),
      );

      const { target: result } = await waitForUnifiedMessageType(session, "result");
      expect(result.metadata.is_error).toBe(true);
      expect(result.metadata.error).toBe("Unexpected error");
    });
  });
});
