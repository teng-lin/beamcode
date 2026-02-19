/**
 * GeminiAdapter e2e tests — exercises GeminiSession directly with mock fetchFn
 * + mock GeminiLauncher, bypassing the launch+connect flow.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { GeminiLauncher } from "../adapters/gemini/gemini-launcher.js";
import { GeminiSession } from "../adapters/gemini/gemini-session.js";
import type { BackendSession } from "../core/interfaces/backend-adapter.js";
import {
  buildA2ACompletedEvent,
  buildA2AInputRequiredEvent,
  buildA2ATaskEvent,
  buildA2ATextEvent,
  buildA2AToolConfirmationEvent,
  collectUnifiedMessages,
  createInterruptMessage,
  createMockProcessManager,
  createPermissionResponse,
  createUserMessage,
  makeSSE,
  sseResponse,
  waitForUnifiedMessageType,
} from "./helpers/backend-test-utils.js";

describe("E2E: GeminiAdapter", () => {
  let session: BackendSession | undefined;
  let mockFetch: ReturnType<typeof vi.fn>;
  let launcher: GeminiLauncher;

  function createSession(): GeminiSession {
    launcher = new GeminiLauncher({ processManager: createMockProcessManager() });
    mockFetch = vi.fn();
    return new GeminiSession({
      sessionId: "e2e-gemini",
      baseUrl: "http://localhost:9999",
      launcher,
      fetchFn: mockFetch as typeof fetch,
    });
  }

  afterEach(async () => {
    if (session) {
      await session.close();
      session = undefined;
    }
  });

  it("full streaming turn: task → text deltas → completed", async () => {
    session = createSession();

    const sse = makeSSE(
      buildA2ATaskEvent(),
      buildA2ATextEvent("Hello "),
      buildA2ATextEvent("world!"),
      buildA2ACompletedEvent(),
    );
    mockFetch.mockResolvedValueOnce(sseResponse(sse));

    session.send(createUserMessage("Hello Gemini"));

    // session_init (task submitted)
    const { target: initMsg } = await waitForUnifiedMessageType(session, "session_init");
    expect(initMsg.metadata.task_id).toBe("task-1");

    // 2 stream_event deltas + 1 result
    const messages = await collectUnifiedMessages(session, 3);

    expect(messages[0].type).toBe("stream_event");
    expect(messages[0].metadata.delta).toBe("Hello ");

    expect(messages[1].type).toBe("stream_event");
    expect(messages[1].metadata.delta).toBe("world!");

    expect(messages[2].type).toBe("result");
    expect(messages[2].metadata.status).toBe("completed");
  });

  it("multi-turn: first turn completes, second starts", async () => {
    session = createSession();

    // Turn 1
    const sse1 = makeSSE(
      buildA2ATaskEvent(),
      buildA2ATextEvent("Response 1"),
      buildA2ACompletedEvent(),
    );
    mockFetch.mockResolvedValueOnce(sseResponse(sse1));

    session.send(createUserMessage("Turn 1"));

    await waitForUnifiedMessageType(session, "session_init");
    const turn1 = await collectUnifiedMessages(session, 2);
    expect(turn1[0].type).toBe("stream_event");
    expect(turn1[1].type).toBe("result");

    // Turn 2
    const sse2 = makeSSE(
      buildA2ATaskEvent("task-2"),
      buildA2ATextEvent("Response 2", "task-2"),
      buildA2ACompletedEvent("task-2"),
    );
    mockFetch.mockResolvedValueOnce(sseResponse(sse2));

    session.send(createUserMessage("Turn 2"));
    expect(mockFetch).toHaveBeenCalledTimes(2);

    await waitForUnifiedMessageType(session, "session_init");
    const turn2 = await collectUnifiedMessages(session, 2);
    expect(turn2[0].type).toBe("stream_event");
    expect(turn2[0].metadata.delta).toBe("Response 2");
    expect(turn2[1].type).toBe("result");
  });

  it("permission: tool-call-confirmation → approve → continues", async () => {
    session = createSession();

    // First call: task + tool confirmation + input-required
    const sse1 = makeSSE(
      buildA2ATaskEvent(),
      buildA2AToolConfirmationEvent("tc-1", "bash"),
      buildA2AInputRequiredEvent(),
    );
    mockFetch.mockResolvedValueOnce(sseResponse(sse1));

    session.send(createUserMessage("Run a command"));

    await waitForUnifiedMessageType(session, "session_init");

    const { target: permReq } = await waitForUnifiedMessageType(session, "permission_request");
    expect(permReq.metadata.tool_name).toBe("bash");
    expect(permReq.metadata.tool_call_id).toBe("tc-1");

    // Wait for result (input-required)
    await waitForUnifiedMessageType(session, "result");

    // Second call: approve → continued response
    const sse2 = makeSSE(buildA2ATextEvent("Approved result"), buildA2ACompletedEvent());
    mockFetch.mockResolvedValueOnce(sseResponse(sse2));

    session.send(
      createPermissionResponse("allow", permReq.id, {
        tool_call_id: "tc-1",
        task_id: "task-1",
      }),
    );

    const messages = await collectUnifiedMessages(session, 2);
    expect(messages[0].type).toBe("stream_event");
    expect(messages[0].metadata.delta).toBe("Approved result");
    expect(messages[1].type).toBe("result");

    // Verify second fetch included taskId
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const body2 = JSON.parse(mockFetch.mock.calls[1][1].body);
    expect(body2.params.id).toBe("task-1");
  });

  it("permission: tool-call-confirmation → deny", async () => {
    session = createSession();

    const sse1 = makeSSE(
      buildA2ATaskEvent(),
      buildA2AToolConfirmationEvent("tc-2", "rm"),
      buildA2AInputRequiredEvent(),
    );
    mockFetch.mockResolvedValueOnce(sseResponse(sse1));

    session.send(createUserMessage("Do something dangerous"));

    await waitForUnifiedMessageType(session, "session_init");
    const { target: permReq } = await waitForUnifiedMessageType(session, "permission_request");

    await waitForUnifiedMessageType(session, "result");

    // Deny
    const sse2 = makeSSE(buildA2ATextEvent("Denied, adjusting"), buildA2ACompletedEvent());
    mockFetch.mockResolvedValueOnce(sseResponse(sse2));

    session.send(
      createPermissionResponse("deny", permReq.id, {
        tool_call_id: "tc-2",
        task_id: "task-1",
      }),
    );

    const messages = await collectUnifiedMessages(session, 2);
    expect(messages[0].type).toBe("stream_event");
    expect(messages[1].type).toBe("result");
  });

  it("cancel (interrupt) sends tasks/cancel and aborts SSE stream", async () => {
    session = createSession();

    const sse1 = makeSSE(buildA2ATaskEvent(), buildA2AInputRequiredEvent());
    mockFetch.mockResolvedValueOnce(sseResponse(sse1));

    session.send(createUserMessage("Start something"));

    await waitForUnifiedMessageType(session, "session_init");
    await waitForUnifiedMessageType(session, "result");

    // Cancel
    mockFetch.mockResolvedValueOnce(new Response("", { status: 200 }));
    session.send(createInterruptMessage());

    await vi.waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    const cancelBody = JSON.parse(mockFetch.mock.calls[1][1].body);
    expect(cancelBody.method).toBe("tasks/cancel");
    expect(cancelBody.params.id).toBe("task-1");
  });

  it("HTTP error surfaces as error result", async () => {
    session = createSession();

    mockFetch.mockResolvedValueOnce(
      new Response("Internal Server Error", { status: 500, statusText: "Internal Server Error" }),
    );

    session.send(createUserMessage("trigger error"));

    const { target: result } = await waitForUnifiedMessageType(session, "result");
    expect(result.metadata.is_error).toBe(true);
    expect(result.metadata.error).toContain("500");
  });

  it("network error surfaces as error result", async () => {
    session = createSession();

    mockFetch.mockRejectedValueOnce(new Error("Network error"));

    session.send(createUserMessage("trigger network error"));

    const { target: result } = await waitForUnifiedMessageType(session, "result");
    expect(result.metadata.is_error).toBe(true);
    expect(result.metadata.error).toBe("Network error");
  });

  it("process exit enqueues error and terminates stream", async () => {
    session = createSession();

    launcher.emit("process:exited", {
      sessionId: "e2e-gemini",
      exitCode: 1,
      uptimeMs: 5000,
    });

    const { target: result } = await waitForUnifiedMessageType(session, "result");
    expect(result.metadata.is_error).toBe(true);
    expect(result.metadata.error).toContain("exited unexpectedly");

    const iter = session.messages[Symbol.asyncIterator]();
    const end = await iter.next();
    expect(end.done).toBe(true);
  });

  it("send after close throws", async () => {
    session = createSession();
    await session.close();

    expect(() => session!.send(createUserMessage("after close"))).toThrow("Session is closed");
    session = undefined;
  });
});
