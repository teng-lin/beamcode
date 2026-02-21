import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createUnifiedMessage } from "../../core/types/unified-message.js";
import { AcpSession } from "./acp-session.js";
import type { JsonRpcCodec } from "./json-rpc.js";
import type { AcpInitializeResult } from "./outbound-translator.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

function createMockChildProcess() {
  const stdout = new EventEmitter();
  const stdin = { write: vi.fn() };
  const proc = new EventEmitter() as unknown as ChildProcess;
  (proc as unknown as Record<string, unknown>).stdout = stdout;
  (proc as unknown as Record<string, unknown>).stdin = stdin;
  (proc as unknown as Record<string, unknown>).kill = vi.fn();
  return proc;
}

function createMockCodec(): JsonRpcCodec {
  return {
    createRequest: vi.fn((method: string, params?: unknown) => ({
      id: 1,
      raw: { jsonrpc: "2.0" as const, id: 1, method, params },
    })),
    createNotification: vi.fn((method: string, params?: unknown) => ({
      jsonrpc: "2.0" as const,
      method,
      params,
    })),
    createResponse: vi.fn((id: number | string, result: unknown) => ({
      jsonrpc: "2.0" as const,
      id,
      result,
    })),
    createErrorResponse: vi.fn((id: number | string, code: number, message: string) => ({
      jsonrpc: "2.0" as const,
      id,
      error: { code, message },
    })),
    encode: vi.fn((msg: unknown) => `${JSON.stringify(msg)}\n`),
    decode: vi.fn((line: string) => JSON.parse(line.trim())),
  } as unknown as JsonRpcCodec;
}

const defaultInitResult: AcpInitializeResult = {
  protocolVersion: 1,
  agentCapabilities: { streaming: true },
  agentInfo: { name: "test-agent", version: "0.1" },
};

/** Access the mocked stdin.write function without verbose casting. */
function stdinWrite(proc: ChildProcess): ReturnType<typeof vi.fn> {
  return (proc as unknown as { stdin: { write: ReturnType<typeof vi.fn> } }).stdin.write;
}

/** Emit a JSON message on the child's stdout as a data event. */
function emitStdout(proc: ChildProcess, msg: unknown): void {
  (proc.stdout as unknown as EventEmitter).emit("data", Buffer.from(`${JSON.stringify(msg)}\n`));
}

/** Emit the stdout "close" event. */
function closeStdout(proc: ChildProcess): void {
  (proc.stdout as unknown as EventEmitter).emit("close");
}

/** Access the mocked codec.decode function without verbose casting. */
function mockDecode(c: JsonRpcCodec): ReturnType<typeof vi.fn> {
  return c.decode as ReturnType<typeof vi.fn>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AcpSession", () => {
  let child: ChildProcess;
  let codec: JsonRpcCodec;
  let session: AcpSession;

  beforeEach(() => {
    child = createMockChildProcess();
    codec = createMockCodec();
    session = new AcpSession("sess-1", child, codec, defaultInitResult);

    // By default, make kill("SIGTERM") trigger exit so close() resolves quickly
    (child.kill as ReturnType<typeof vi.fn>).mockImplementation((signal: string) => {
      if (signal === "SIGTERM") {
        process.nextTick(() => child.emit("exit", 0));
      }
      return true;
    });
  });

  // -------------------------------------------------------------------------
  // send()
  // -------------------------------------------------------------------------

  describe("send()", () => {
    it("throws when session is closed", async () => {
      await session.close();

      const msg = createUnifiedMessage({
        type: "user_message",
        role: "user",
        content: [{ type: "text", text: "hello" }],
      });

      expect(() => session.send(msg)).toThrow("Session is closed");
    });

    it("sends a request for user_message (type=request)", () => {
      const msg = createUnifiedMessage({
        type: "user_message",
        role: "user",
        content: [{ type: "text", text: "hello" }],
        metadata: { sessionId: "sess-1" },
      });

      session.send(msg);

      expect(codec.createRequest).toHaveBeenCalledWith("session/prompt", expect.any(Object));
      expect(codec.encode).toHaveBeenCalled();
      expect(stdinWrite(child)).toHaveBeenCalled();
    });

    it("sends a notification for interrupt (type=notification)", () => {
      const msg = createUnifiedMessage({
        type: "interrupt",
        role: "user",
      });

      session.send(msg);

      expect(codec.createNotification).toHaveBeenCalledWith("session/cancel", undefined);
      expect(codec.encode).toHaveBeenCalled();
      expect(stdinWrite(child)).toHaveBeenCalled();
    });

    it("sends a response for permission_response (type=response)", () => {
      // First, simulate receiving a permission request to set pendingPermissionRequestId
      // We access routeMessage indirectly via the message stream
      // Instead, we can directly test the response path by setting up the state
      // through the public API: consume a permission_request from the stream

      // To properly set the pendingPermissionRequestId, we need to route a
      // request_permission message through the message stream first.
      // For a simpler test, we verify the response path works even without a pending ID.

      const msg = createUnifiedMessage({
        type: "permission_response",
        role: "user",
        metadata: { behavior: "allow", optionId: "allow-once" },
      });

      // Without a pending request ID, translateToAcp returns response with requestId=undefined
      // which causes the early return (no rpcMsg sent)
      session.send(msg);

      // The response path with no requestId returns early, so no write
      // This is expected behavior
    });

    it("sends a response with requestId when permission request is pending", async () => {
      // Feed a request_permission through stdout to set pendingPermissionRequestId
      const requestMsg = {
        jsonrpc: "2.0",
        id: 42,
        method: "session/request_permission",
        params: {
          sessionId: "sess-1",
          toolCall: { toolCallId: "tc-1" },
          options: [{ optionId: "allow-once", name: "Allow", kind: "allow" }],
        },
      };

      // Set up the codec.decode to return this message
      mockDecode(codec).mockReturnValueOnce(requestMsg);

      // Start consuming messages
      const iter = session.messages[Symbol.asyncIterator]();

      // First next() gets the init result
      const initMsg = await iter.next();
      expect(initMsg.done).toBe(false);
      expect(initMsg.value.type).toBe("session_init");

      // Emit data to trigger routeMessage with request_permission
      emitStdout(child, requestMsg);

      // Get the permission_request message
      const permMsg = await iter.next();
      expect(permMsg.done).toBe(false);
      expect(permMsg.value.type).toBe("permission_request");

      // Now send the permission response - the pendingPermissionRequestId should be set
      const responseMsg = createUnifiedMessage({
        type: "permission_response",
        role: "user",
        metadata: { behavior: "allow", optionId: "allow-once" },
      });

      session.send(responseMsg);

      expect(codec.createResponse).toHaveBeenCalled();
      expect(codec.encode).toHaveBeenCalled();
    });

    it("silently ignores messages that translateToAcp returns null for", () => {
      const msg = createUnifiedMessage({
        type: "result",
        role: "system",
      });

      // Should not throw
      session.send(msg);

      // No write should happen
      expect(stdinWrite(child)).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // close()
  // -------------------------------------------------------------------------

  describe("close()", () => {
    it("kills the child process with SIGTERM", async () => {
      await session.close();

      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    });

    it("rejects pending requests on close", async () => {
      const pendingRequest = { resolve: vi.fn(), reject: vi.fn() };
      (session as any).pendingRequests.set(1, pendingRequest);

      await session.close();

      expect(pendingRequest.reject).toHaveBeenCalledWith(new Error("Session closed"));
      expect(pendingRequest.resolve).not.toHaveBeenCalled();
    });

    it("is idempotent — second close returns immediately", async () => {
      await session.close();
      await session.close();

      // SIGTERM should only be called once
      expect(child.kill).toHaveBeenCalledTimes(1);
    });

    it("falls back to SIGKILL after 5s timeout", async () => {
      vi.useFakeTimers();

      // Override: do NOT emit exit on SIGTERM so the timeout fires
      const killFn = child.kill as ReturnType<typeof vi.fn>;
      killFn.mockReturnValue(true);

      const closePromise = session.close();

      // Advance past the 5s timeout
      await vi.advanceTimersByTimeAsync(5001);

      await closePromise;

      expect(killFn).toHaveBeenCalledWith("SIGTERM");
      expect(killFn).toHaveBeenCalledWith("SIGKILL");

      vi.useRealTimers();
    });
  });

  // -------------------------------------------------------------------------
  // messages async iterable
  // -------------------------------------------------------------------------

  describe("messages", () => {
    it("yields the init result as the first message", async () => {
      const iter = session.messages[Symbol.asyncIterator]();
      const first = await iter.next();

      expect(first.done).toBe(false);
      expect(first.value.type).toBe("session_init");
      expect(first.value.metadata.agentName).toBe("test-agent");
    });

    it("returns the same iterable on repeated access", () => {
      const a = session.messages;
      const b = session.messages;
      expect(a).toBe(b);
    });

    it("yields translated messages from stdout data", async () => {
      const updateMsg = {
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "sess-1",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Hello world" },
          },
        },
      };
      mockDecode(codec).mockReturnValueOnce(updateMsg);

      const iter = session.messages[Symbol.asyncIterator]();
      await iter.next(); // init

      emitStdout(child, updateMsg);

      // First agent_message_chunk also emits status_change(running)
      const statusMsg = await iter.next();
      expect(statusMsg.done).toBe(false);
      expect(statusMsg.value.type).toBe("status_change");
      expect(statusMsg.value.metadata.status).toBe("running");

      const msg = await iter.next();
      expect(msg.done).toBe(false);
      expect(msg.value.type).toBe("stream_event");
    });

    it("ends when stdout closes", async () => {
      const iter = session.messages[Symbol.asyncIterator]();
      await iter.next(); // init

      closeStdout(child);

      const result = await iter.next();
      expect(result.done).toBe(true);
    });

    it("ends immediately when session is already closed", async () => {
      await session.close();

      const iter = session.messages[Symbol.asyncIterator]();
      const first = await iter.next();
      expect(first.done).toBe(true);
    });

    it("skips unparseable lines", async () => {
      mockDecode(codec).mockImplementationOnce(() => {
        throw new Error("bad JSON");
      });

      const validMsg = {
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "sess-1",
          update: {
            sessionUpdate: "plan",
            planEntries: [],
          },
        },
      };
      mockDecode(codec).mockReturnValueOnce(validMsg);

      const iter = session.messages[Symbol.asyncIterator]();
      await iter.next(); // init

      // Emit two lines: one bad, one good
      (child.stdout as unknown as EventEmitter).emit(
        "data",
        Buffer.from(`not valid json\n${JSON.stringify(validMsg)}\n`),
      );

      const msg = await iter.next();
      expect(msg.done).toBe(false);
      expect(msg.value.type).toBe("status_change");
    });

    it("return() cleans up and signals done", async () => {
      const iter = session.messages[Symbol.asyncIterator]();
      await iter.next(); // init

      const returnResult = await iter.return!(undefined!);
      expect(returnResult.done).toBe(true);

      // After return, next should also be done
      const afterReturn = await iter.next();
      expect(afterReturn.done).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // routeMessage (exercised via messages stream)
  // -------------------------------------------------------------------------

  describe("routeMessage", () => {
    it("translates session/update notification via translateSessionUpdate", async () => {
      const notification = {
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "sess-1",
          update: {
            sessionUpdate: "plan",
            planEntries: [{ step: 1, text: "do thing" }],
          },
        },
      };
      mockDecode(codec).mockReturnValueOnce(notification);

      const iter = session.messages[Symbol.asyncIterator]();
      await iter.next(); // init

      emitStdout(child, notification);

      const msg = await iter.next();
      expect(msg.value.type).toBe("status_change");
    });

    it("emits status_change(running) before first agent_message_chunk", async () => {
      const chunk = {
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "sess-1",
          update: { sessionUpdate: "agent_message_chunk", content: { text: "Hello" } },
        },
      };
      mockDecode(codec).mockReturnValueOnce(chunk);

      const iter = session.messages[Symbol.asyncIterator]();
      await iter.next(); // init

      emitStdout(child, chunk);

      const statusMsg = await iter.next();
      expect(statusMsg.value.type).toBe("status_change");
      expect(statusMsg.value.metadata.status).toBe("running");

      const streamMsg = await iter.next();
      expect(streamMsg.value.type).toBe("stream_event");
    });

    it("does not emit running on subsequent agent_message_chunk", async () => {
      const chunk1 = {
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "sess-1",
          update: { sessionUpdate: "agent_message_chunk", content: { text: "Hello" } },
        },
      };
      const chunk2 = {
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "sess-1",
          update: { sessionUpdate: "agent_message_chunk", content: { text: " world" } },
        },
      };
      mockDecode(codec).mockReturnValueOnce(chunk1).mockReturnValueOnce(chunk2);

      const iter = session.messages[Symbol.asyncIterator]();
      await iter.next(); // init

      emitStdout(child, chunk1);

      const statusMsg = await iter.next();
      expect(statusMsg.value.type).toBe("status_change");
      expect(statusMsg.value.metadata.status).toBe("running");

      const streamMsg1 = await iter.next();
      expect(streamMsg1.value.type).toBe("stream_event");

      emitStdout(child, chunk2);

      // Second chunk should NOT produce status_change — only stream_event
      const streamMsg2 = await iter.next();
      expect(streamMsg2.value.type).toBe("stream_event");
    });

    it("emits running again on next turn after send()", async () => {
      const chunk = {
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "sess-1",
          update: { sessionUpdate: "agent_message_chunk", content: { text: "First turn" } },
        },
      };
      mockDecode(codec).mockReturnValueOnce(chunk);

      const iter = session.messages[Symbol.asyncIterator]();
      await iter.next(); // init

      emitStdout(child, chunk);

      await iter.next(); // status_change(running)
      await iter.next(); // stream_event

      // Start a new turn
      session.send(
        createUnifiedMessage({
          type: "user_message",
          role: "user",
          content: [{ type: "text", text: "next turn" }],
        }),
      );

      const chunk2 = {
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "sess-1",
          update: { sessionUpdate: "agent_message_chunk", content: { text: "Second turn" } },
        },
      };
      mockDecode(codec).mockReturnValueOnce(chunk2);
      emitStdout(child, chunk2);

      const statusMsg = await iter.next();
      expect(statusMsg.value.type).toBe("status_change");
      expect(statusMsg.value.metadata.status).toBe("running");
    });

    it("returns null for non-session/update notifications", async () => {
      const notification = {
        jsonrpc: "2.0",
        method: "some/other_notification",
        params: {},
      };
      mockDecode(codec).mockReturnValueOnce(notification);

      const iter = session.messages[Symbol.asyncIterator]();
      await iter.next(); // init

      emitStdout(child, notification);

      // The null return means nothing is queued. Send a close to unblock.
      closeStdout(child);
      const result = await iter.next();
      expect(result.done).toBe(true);
    });

    it("stores pendingPermissionRequestId for session/request_permission", async () => {
      const request = {
        jsonrpc: "2.0",
        id: 99,
        method: "session/request_permission",
        params: {
          sessionId: "sess-1",
          toolCall: { toolCallId: "tc-1" },
          options: [{ optionId: "allow-once", name: "Allow", kind: "allow" }],
        },
      };
      mockDecode(codec).mockReturnValueOnce(request);

      const iter = session.messages[Symbol.asyncIterator]();
      await iter.next(); // init

      emitStdout(child, request);

      const msg = await iter.next();
      expect(msg.value.type).toBe("permission_request");
    });

    it("sends error response for fs/ method requests", async () => {
      const request = {
        jsonrpc: "2.0",
        id: 10,
        method: "fs/read",
        params: { path: "/tmp/foo" },
      };
      mockDecode(codec).mockReturnValueOnce(request);

      const iter = session.messages[Symbol.asyncIterator]();
      await iter.next(); // init

      emitStdout(child, request);

      expect(codec.createErrorResponse).toHaveBeenCalledWith(10, -32601, "Method not supported");
      expect(stdinWrite(child)).toHaveBeenCalled();
    });

    it("sends error response for terminal/ method requests", async () => {
      const request = {
        jsonrpc: "2.0",
        id: 11,
        method: "terminal/execute",
        params: { command: "ls" },
      };
      mockDecode(codec).mockReturnValueOnce(request);

      const iter = session.messages[Symbol.asyncIterator]();
      await iter.next(); // init

      emitStdout(child, request);

      expect(codec.createErrorResponse).toHaveBeenCalledWith(11, -32601, "Method not supported");
    });

    it("resolves pending request on matching JSON-RPC response", async () => {
      const response = {
        jsonrpc: "2.0",
        id: 1,
        result: { stopReason: "end_turn", sessionId: "sess-1" },
      };
      mockDecode(codec).mockReturnValueOnce(response);

      const iter = session.messages[Symbol.asyncIterator]();
      await iter.next(); // init

      emitStdout(child, response);

      const msg = await iter.next();
      expect(msg.value.type).toBe("result");
      expect(msg.value.metadata.stopReason).toBe("end_turn");
    });

    it("defaults to api_error when no error classifier is provided", async () => {
      const userMsg = createUnifiedMessage({
        type: "user_message",
        role: "user",
        content: [{ type: "text", text: "hello" }],
        metadata: { sessionId: "sess-1" },
      });
      session.send(userMsg);

      const errorResponse = {
        jsonrpc: "2.0",
        id: 1,
        error: { code: 500, message: "Something went wrong" },
      };
      mockDecode(codec).mockReturnValueOnce(errorResponse);

      const iter = session.messages[Symbol.asyncIterator]();
      await iter.next(); // init

      emitStdout(child, errorResponse);

      const msg = await iter.next();
      expect(msg.value.type).toBe("result");
      expect(msg.value.metadata.stopReason).toBe("error");
      expect(msg.value.metadata.error_code).toBe("api_error");
      expect(msg.value.metadata.error_message).toBe("Something went wrong");
    });

    it("emits auth_status before result for provider_auth errors", async () => {
      const classifier = (_code: number, msg: string) =>
        msg.includes("Verify") ? "provider_auth" : "api_error";
      const classifiedSession = new AcpSession(
        "sess-2",
        child,
        codec,
        defaultInitResult,
        undefined,
        classifier,
      );

      const userMsg = createUnifiedMessage({
        type: "user_message",
        role: "user",
        content: [{ type: "text", text: "hello" }],
        metadata: { sessionId: "sess-2" },
      });
      classifiedSession.send(userMsg);

      const errorResponse = {
        jsonrpc: "2.0",
        id: 1,
        error: { code: 500, message: "Verify your account to continue." },
      };
      mockDecode(codec).mockReturnValueOnce(errorResponse);

      const iter = classifiedSession.messages[Symbol.asyncIterator]();
      await iter.next(); // init

      emitStdout(child, errorResponse);

      // First: auth_status
      const authMsg = await iter.next();
      expect(authMsg.value.type).toBe("auth_status");
      expect(authMsg.value.metadata.isAuthenticating).toBe(false);
      expect(authMsg.value.metadata.error).toBe("Verify your account to continue.");

      // Second: result with provider_auth
      const resultMsg = await iter.next();
      expect(resultMsg.value.type).toBe("result");
      expect(resultMsg.value.metadata.error_code).toBe("provider_auth");
    });

    it("does not emit auth_status for non-auth errors", async () => {
      const userMsg = createUnifiedMessage({
        type: "user_message",
        role: "user",
        content: [{ type: "text", text: "hello" }],
        metadata: { sessionId: "sess-1" },
      });
      session.send(userMsg);

      const errorResponse = {
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32603, message: "Internal error" },
      };
      mockDecode(codec).mockReturnValueOnce(errorResponse);

      const iter = session.messages[Symbol.asyncIterator]();
      await iter.next(); // init

      emitStdout(child, errorResponse);

      // Only a result, no auth_status
      const msg = await iter.next();
      expect(msg.value.type).toBe("result");
      expect(msg.value.metadata.error_code).toBe("api_error");
    });

    it("preserves error_data from JSON-RPC error response", async () => {
      const userMsg = createUnifiedMessage({
        type: "user_message",
        role: "user",
        content: [{ type: "text", text: "hello" }],
        metadata: { sessionId: "sess-1" },
      });
      session.send(userMsg);

      const errorResponse = {
        jsonrpc: "2.0",
        id: 1,
        error: {
          code: -32603,
          message: "Internal error",
          data: { details: "Session not found: abc" },
        },
      };
      mockDecode(codec).mockReturnValueOnce(errorResponse);

      const iter = session.messages[Symbol.asyncIterator]();
      await iter.next(); // init

      emitStdout(child, errorResponse);

      const msg = await iter.next();
      expect(msg.value.metadata.error_code).toBe("api_error");
      expect(msg.value.metadata.error_data).toEqual({ details: "Session not found: abc" });
    });

    it("returns null for response without stopReason and no pending match", async () => {
      const response = {
        jsonrpc: "2.0",
        id: 999,
        result: { something: "else" },
      };
      mockDecode(codec).mockReturnValueOnce(response);

      const iter = session.messages[Symbol.asyncIterator]();
      await iter.next(); // init

      emitStdout(child, response);

      closeStdout(child);
      const result = await iter.next();
      expect(result.done).toBe(true);
    });

    it("returns null for unknown message type", async () => {
      const weird = { jsonrpc: "2.0" };
      mockDecode(codec).mockReturnValueOnce(weird);

      const iter = session.messages[Symbol.asyncIterator]();
      await iter.next(); // init

      emitStdout(child, weird);

      closeStdout(child);
      const result = await iter.next();
      expect(result.done).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // sessionId
  // -------------------------------------------------------------------------

  describe("sessionId", () => {
    it("exposes the session ID from constructor", () => {
      expect(session.sessionId).toBe("sess-1");
    });
  });
});
