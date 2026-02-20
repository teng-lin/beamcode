/**
 * OpencodeAdapter e2e tests — exercises OpencodeSession directly with mock
 * OpencodeHttpClient + mock subscribe, testing full multi-turn flows.
 */

import { afterEach, describe, expect, it } from "vitest";
import { OpencodeSession } from "../adapters/opencode/opencode-session.js";
import type { BackendSession } from "../core/interfaces/backend-adapter.js";
import {
  buildOpencodeAssistantUpdatedEvent,
  buildOpencodeBusyEvent,
  buildOpencodeConnectedEvent,
  buildOpencodeIdleEvent,
  buildOpencodePermissionEvent,
  buildOpencodeRetryEvent,
  buildOpencodeSessionErrorEvent,
  buildOpencodeTextDeltaEvent,
  buildOpencodeTextPartEvent,
  buildOpencodeToolCompletedEvent,
  buildOpencodeToolErrorEvent,
  buildOpencodeToolRunningEvent,
  collectUnifiedMessages,
  createInterruptMessage,
  createMockOpencodeHttpClient,
  createMockOpencodeSubscribe,
  createPermissionResponse,
  createUserMessage,
  waitForUnifiedMessageType,
} from "./helpers/backend-test-utils.js";

describe("E2E: OpencodeAdapter", () => {
  let session: BackendSession | undefined;
  let httpClient: ReturnType<typeof createMockOpencodeHttpClient>;
  let sub: ReturnType<typeof createMockOpencodeSubscribe>;

  function tick(ms = 10): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function createSession(opcSessionId = "opc-session-1"): OpencodeSession {
    httpClient = createMockOpencodeHttpClient();
    sub = createMockOpencodeSubscribe();
    return new OpencodeSession({
      sessionId: "e2e-opencode",
      opcSessionId,
      httpClient,
      subscribe: sub.subscribe,
    });
  }

  afterEach(async () => {
    if (session) {
      await session.close();
      session = undefined;
    }
  });

  it("full turn with SSE events: connected → busy → text deltas → idle", async () => {
    session = createSession();

    // Push connected event
    sub.push(buildOpencodeConnectedEvent());

    const { target: initMsg } = await waitForUnifiedMessageType(session, "session_init");
    expect(initMsg.type).toBe("session_init");

    // Send user message
    session.send(createUserMessage("Hello opencode"));
    expect(httpClient.promptAsync).toHaveBeenCalledOnce();

    // Simulate busy → text deltas → idle
    sub.push(buildOpencodeBusyEvent());
    sub.push(buildOpencodeTextPartEvent("Hello ", "Hello "));
    sub.push(buildOpencodeTextPartEvent("Hello world!", "world!"));
    sub.push(buildOpencodeIdleEvent());

    const messages = await collectUnifiedMessages(session, 4);

    expect(messages[0].type).toBe("status_change");
    expect(messages[0].metadata.busy).toBe(true);

    expect(messages[1].type).toBe("stream_event");
    expect(messages[1].metadata.delta).toBe("Hello ");

    expect(messages[2].type).toBe("stream_event");
    expect(messages[2].metadata.delta).toBe("world!");

    expect(messages[3].type).toBe("result");
    expect(messages[3].metadata.status).toBe("completed");
  });

  it("multi-turn: first turn completes, second starts", async () => {
    session = createSession();

    sub.push(buildOpencodeConnectedEvent());
    await waitForUnifiedMessageType(session, "session_init");

    // Turn 1
    session.send(createUserMessage("Turn 1"));
    sub.push(buildOpencodeTextPartEvent("Response 1", "Response 1"));
    sub.push(buildOpencodeIdleEvent());

    const turn1 = await collectUnifiedMessages(session, 2);
    expect(turn1[0].type).toBe("stream_event");
    expect(turn1[1].type).toBe("result");

    // Turn 2
    session.send(createUserMessage("Turn 2"));
    expect(httpClient.promptAsync).toHaveBeenCalledTimes(2);

    sub.push(buildOpencodeTextPartEvent("Response 2", "Response 2"));
    sub.push(buildOpencodeIdleEvent());

    const turn2 = await collectUnifiedMessages(session, 2);
    expect(turn2[0].type).toBe("stream_event");
    expect(turn2[0].metadata.delta).toBe("Response 2");
    expect(turn2[1].type).toBe("result");
  });

  it("permission flow: permission_request → approve → continues", async () => {
    session = createSession();

    sub.push(buildOpencodeConnectedEvent());
    await waitForUnifiedMessageType(session, "session_init");

    session.send(createUserMessage("Edit a file"));

    // Server requests permission
    sub.push(buildOpencodePermissionEvent("perm-1", "file_edit", { title: "Edit test.ts" }));

    const { target: permReq } = await waitForUnifiedMessageType(session, "permission_request");
    expect(permReq.metadata.request_id).toBe("perm-1");
    expect(permReq.metadata.permission).toBe("file_edit");

    // Approve
    session.send(createPermissionResponse("allow", permReq.id, { request_id: "perm-1" }));
    expect(httpClient.replyPermission).toHaveBeenCalledOnce();
    expect(httpClient.replyPermission).toHaveBeenCalledWith("perm-1", { reply: "once" });

    // Server continues
    sub.push(buildOpencodeTextPartEvent("Done editing", "Done editing"));
    sub.push(buildOpencodeIdleEvent());

    const messages = await collectUnifiedMessages(session, 2);
    expect(messages[0].type).toBe("stream_event");
    expect(messages[1].type).toBe("result");
  });

  it("permission flow: deny permission", async () => {
    session = createSession();

    sub.push(buildOpencodeConnectedEvent());
    await waitForUnifiedMessageType(session, "session_init");

    session.send(createUserMessage("Delete something"));

    sub.push(buildOpencodePermissionEvent("perm-2", "file_delete"));

    const { target: permReq } = await waitForUnifiedMessageType(session, "permission_request");

    // Deny
    session.send(createPermissionResponse("deny", permReq.id, { request_id: "perm-2" }));
    expect(httpClient.replyPermission).toHaveBeenCalledOnce();
    expect(httpClient.replyPermission).toHaveBeenCalledWith("perm-2", { reply: "reject" });
  });

  it("permission flow: allow_always maps to persistent allow", async () => {
    session = createSession();

    sub.push(buildOpencodeConnectedEvent());
    await waitForUnifiedMessageType(session, "session_init");

    session.send(createUserMessage("Always allow this"));
    sub.push(buildOpencodePermissionEvent("perm-3", "file_edit"));
    const { target: permReq } = await waitForUnifiedMessageType(session, "permission_request");

    session.send(createPermissionResponse("always", permReq.id, { request_id: "perm-3" }));

    expect(httpClient.replyPermission).toHaveBeenCalledOnce();
    expect(httpClient.replyPermission).toHaveBeenCalledWith("perm-3", { reply: "always" });
  });

  it("interrupt sends abort", async () => {
    session = createSession();

    sub.push(buildOpencodeConnectedEvent());
    await waitForUnifiedMessageType(session, "session_init");

    session.send(createUserMessage("Start something"));
    session.send(createInterruptMessage());

    expect(httpClient.abort).toHaveBeenCalledOnce();
    expect(httpClient.abort).toHaveBeenCalledWith("opc-session-1");
  });

  it("tool flow: running → completed emits progress + summary with output", async () => {
    session = createSession();

    sub.push(buildOpencodeConnectedEvent());
    await waitForUnifiedMessageType(session, "session_init");

    session.send(createUserMessage("Show README"));
    sub.push(
      buildOpencodeToolRunningEvent({
        callId: "call-read-1",
        tool: "read",
        input: { filePath: "/repo/README.md", limit: 50 },
      }),
    );
    sub.push(
      buildOpencodeToolCompletedEvent("<content>1: # beamcode</content>", {
        callId: "call-read-1",
        tool: "read",
        input: { filePath: "/repo/README.md", limit: 50 },
        title: "README.md",
        start: 1_000,
        end: 1_900,
      }),
    );
    sub.push(buildOpencodeIdleEvent());

    const messages = await collectUnifiedMessages(session, 3);
    expect(messages[0].type).toBe("tool_progress");
    expect(messages[0].metadata.call_id).toBe("call-read-1");
    expect(messages[0].metadata.tool).toBe("read");

    expect(messages[1].type).toBe("tool_use_summary");
    expect(messages[1].metadata.call_id).toBe("call-read-1");
    expect(messages[1].metadata.output).toContain("# beamcode");
    expect(messages[1].metadata.status).toBe("completed");

    expect(messages[2].type).toBe("result");
    expect(messages[2].metadata.status).toBe("completed");
  });

  it("tool flow: error emits summary with is_error", async () => {
    session = createSession();

    sub.push(buildOpencodeConnectedEvent());
    await waitForUnifiedMessageType(session, "session_init");

    session.send(createUserMessage("Read missing file"));
    sub.push(
      buildOpencodeToolErrorEvent("ENOENT: no such file or directory", {
        callId: "call-read-2",
        tool: "read",
      }),
    );
    sub.push(buildOpencodeIdleEvent());

    const messages = await collectUnifiedMessages(session, 2);
    expect(messages[0].type).toBe("tool_use_summary");
    expect(messages[0].metadata.call_id).toBe("call-read-2");
    expect(messages[0].metadata.is_error).toBe(true);
    expect(messages[0].metadata.error).toContain("ENOENT");

    expect(messages[1].type).toBe("result");
  });

  it("preserves assistant text across duplicate message.updated events with same message id", async () => {
    session = createSession();

    sub.push(buildOpencodeConnectedEvent());
    await waitForUnifiedMessageType(session, "session_init");

    session.send(createUserMessage("Show me README"));
    sub.push(buildOpencodeTextDeltaEvent("First 50 lines of "));
    sub.push(buildOpencodeTextDeltaEvent("README.md", { partId: "p-1", messageId: "m-1" }));
    sub.push(
      buildOpencodeAssistantUpdatedEvent({
        messageId: "m-1",
        created: 1_000,
      }),
    );

    const firstBatch = await collectUnifiedMessages(session, 3);
    expect(firstBatch[0].type).toBe("stream_event");
    expect(firstBatch[1].type).toBe("stream_event");
    expect(firstBatch[2].type).toBe("assistant");
    expect(firstBatch[2].content).toEqual([{ type: "text", text: "First 50 lines of README.md" }]);

    sub.push(
      buildOpencodeAssistantUpdatedEvent({
        messageId: "m-1",
        created: 1_000,
        completed: 1_200,
      }),
    );
    const { target: secondAssistant } = await waitForUnifiedMessageType(session, "assistant");
    expect(secondAssistant.content).toEqual([
      { type: "text", text: "First 50 lines of README.md" },
    ]);
  });

  it("session.status retry emits retry metadata", async () => {
    session = createSession();

    sub.push(buildOpencodeRetryEvent({ attempt: 2, message: "rate limited", next: 3_000 }));

    const { target: status } = await waitForUnifiedMessageType(session, "status_change");
    expect(status.metadata.retry).toBe(true);
    expect(status.metadata.attempt).toBe(2);
    expect(status.metadata.message).toBe("rate limited");
    expect(status.metadata.next).toBe(3_000);
  });

  it("session.error api_error maps status + normalized code", async () => {
    session = createSession();

    sub.push(
      buildOpencodeSessionErrorEvent({
        name: "api_error",
        message: "Rate limit",
        status: 429,
      }),
    );

    const { target: result } = await waitForUnifiedMessageType(session, "result");
    expect(result.metadata.is_error).toBe(true);
    expect(result.metadata.error_code).toBe("api_error");
    expect(result.metadata.error_message).toBe("Rate limit");
    expect(result.metadata.error_status).toBe(429);
  });

  it("session.error unknown maps unknown error_code", async () => {
    session = createSession();

    sub.push(buildOpencodeSessionErrorEvent({ name: "unknown", message: "Unexpected failure" }));

    const { target: result } = await waitForUnifiedMessageType(session, "result");
    expect(result.metadata.is_error).toBe(true);
    expect(result.metadata.error_code).toBe("unknown");
    expect(result.metadata.error_message).toBe("Unexpected failure");
  });

  it("HTTP error surfaces as error result in message queue", async () => {
    session = createSession();

    httpClient.promptAsync.mockRejectedValueOnce(new Error("Network failure"));

    session.send(createUserMessage("will fail"));

    // Wait for the rejected promise to be caught
    await new Promise((r) => setTimeout(r, 10));

    const { target: result } = await waitForUnifiedMessageType(session, "result");
    expect(result.metadata.is_error).toBe(true);
    expect(result.metadata.error_message).toBe("Network failure");
  });

  it("permission reply HTTP failure surfaces error result", async () => {
    session = createSession();

    httpClient.replyPermission.mockRejectedValueOnce(new Error("Permission API unavailable"));

    session.send(createPermissionResponse("allow", "perm-10", { request_id: "perm-10" }));
    await tick();

    const { target: result } = await waitForUnifiedMessageType(session, "result");
    expect(result.metadata.is_error).toBe(true);
    expect(result.metadata.error_message).toBe("Permission API unavailable");
  });

  it("abort HTTP failure surfaces error result", async () => {
    session = createSession();

    httpClient.abort.mockRejectedValueOnce(new Error("Abort failed"));

    session.send(createInterruptMessage());
    await tick();

    const { target: result } = await waitForUnifiedMessageType(session, "result");
    expect(result.metadata.is_error).toBe(true);
    expect(result.metadata.error_message).toBe("Abort failed");
  });

  it("drops non-user-facing opencode events", async () => {
    session = createSession();
    const iter = session.messages[Symbol.asyncIterator]();

    sub.push({ type: "server.heartbeat", properties: {} });
    sub.push({
      type: "permission.replied",
      properties: { id: "perm-1", sessionID: "opc-session-1", reply: "once" },
    });
    sub.push({
      type: "message.part.removed",
      properties: { partID: "p-1", messageID: "m-1", sessionID: "opc-session-1" },
    });

    const outcome = await Promise.race([
      iter.next().then(() => "message"),
      new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 30)),
    ]);

    expect(outcome).toBe("timeout");
  });

  it("send after close throws", async () => {
    session = createSession();
    await session.close();

    expect(() => session!.send(createUserMessage("after close"))).toThrow("Session is closed");
    session = undefined;
  });

  it("close unsubscribes from SSE events", async () => {
    session = createSession();
    await session.close();

    expect(sub.unsubscribe).toHaveBeenCalledOnce();
    session = undefined;
  });

  it("close terminates message iterator", async () => {
    session = createSession();
    const iter = session.messages[Symbol.asyncIterator]();
    const nextPromise = iter.next();

    await session.close();

    const result = await nextPromise;
    expect(result.done).toBe(true);
    session = undefined;
  });
});
