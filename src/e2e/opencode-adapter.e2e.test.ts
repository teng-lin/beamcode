/**
 * OpencodeAdapter e2e tests — exercises OpencodeSession directly with mock
 * OpencodeHttpClient + mock subscribe, testing full multi-turn flows.
 */

import { afterEach, describe, expect, it } from "vitest";
import { OpencodeSession } from "../adapters/opencode/opencode-session.js";
import type { BackendSession } from "../core/interfaces/backend-adapter.js";
import { createUnifiedMessage } from "../core/types/unified-message.js";
import {
  buildOpencodeAssistantUpdatedEvent,
  buildOpencodeBusyEvent,
  buildOpencodeCompactedEvent,
  buildOpencodeConnectedEvent,
  buildOpencodeIdleEvent,
  buildOpencodeMessageRemovedEvent,
  buildOpencodePermissionEvent,
  buildOpencodeReasoningPartEvent,
  buildOpencodeRetryEvent,
  buildOpencodeSessionErrorEvent,
  buildOpencodeStepFinishEvent,
  buildOpencodeStepStartEvent,
  buildOpencodeTextDeltaEvent,
  buildOpencodeTextPartEvent,
  buildOpencodeToolCompletedEvent,
  buildOpencodeToolErrorEvent,
  buildOpencodeToolPendingEvent,
  buildOpencodeToolRunningEvent,
  buildOpencodeUserUpdatedEvent,
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

  // ---------------------------------------------------------------------------
  // Core turn lifecycle
  // ---------------------------------------------------------------------------

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

  it("three-turn conversation maintains correct state across all turns", async () => {
    session = createSession();

    sub.push(buildOpencodeConnectedEvent());
    await waitForUnifiedMessageType(session, "session_init");

    for (let turn = 1; turn <= 3; turn++) {
      session.send(createUserMessage(`Turn ${turn}`));
      sub.push(buildOpencodeTextPartEvent(`Response ${turn}`, `Response ${turn}`));
      sub.push(buildOpencodeIdleEvent());

      const messages = await collectUnifiedMessages(session, 2);
      expect(messages[0].type).toBe("stream_event");
      expect(messages[0].metadata.delta).toBe(`Response ${turn}`);
      expect(messages[1].type).toBe("result");
    }

    expect(httpClient.promptAsync).toHaveBeenCalledTimes(3);
  });

  it("busy → retry → busy → idle flow emits correct status sequence", async () => {
    session = createSession();

    sub.push(buildOpencodeBusyEvent());
    sub.push(buildOpencodeRetryEvent({ attempt: 1, message: "rate limited", next: 1_000 }));
    sub.push(buildOpencodeBusyEvent());
    sub.push(buildOpencodeTextPartEvent("Success", "Success"));
    sub.push(buildOpencodeIdleEvent());

    const messages = await collectUnifiedMessages(session, 5);

    expect(messages[0].type).toBe("status_change");
    expect(messages[0].metadata.busy).toBe(true);

    expect(messages[1].type).toBe("status_change");
    expect(messages[1].metadata.retry).toBe(true);

    expect(messages[2].type).toBe("status_change");
    expect(messages[2].metadata.busy).toBe(true);

    expect(messages[3].type).toBe("stream_event");
    expect(messages[4].type).toBe("result");
  });

  // ---------------------------------------------------------------------------
  // Permission flows
  // ---------------------------------------------------------------------------

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

  it("permission request preserves title metadata", async () => {
    session = createSession();

    sub.push(
      buildOpencodePermissionEvent("perm-title", "bash_execute", {
        title: "Run: npm test",
      }),
    );

    const { target: permReq } = await waitForUnifiedMessageType(session, "permission_request");
    expect(permReq.metadata.request_id).toBe("perm-title");
    expect(permReq.metadata.permission).toBe("bash_execute");
    expect(permReq.metadata.title).toBe("Run: npm test");
  });

  it("multiple permission requests within a single turn", async () => {
    session = createSession();

    sub.push(buildOpencodeConnectedEvent());
    await waitForUnifiedMessageType(session, "session_init");

    session.send(createUserMessage("Edit two files"));

    // Two permission requests in sequence
    sub.push(buildOpencodePermissionEvent("perm-a", "file_edit", { title: "Edit foo.ts" }));

    const { target: perm1 } = await waitForUnifiedMessageType(session, "permission_request");
    expect(perm1.metadata.request_id).toBe("perm-a");

    session.send(createPermissionResponse("allow", perm1.id, { request_id: "perm-a" }));

    sub.push(buildOpencodePermissionEvent("perm-b", "file_edit", { title: "Edit bar.ts" }));

    const { target: perm2 } = await waitForUnifiedMessageType(session, "permission_request");
    expect(perm2.metadata.request_id).toBe("perm-b");

    session.send(createPermissionResponse("allow", perm2.id, { request_id: "perm-b" }));

    expect(httpClient.replyPermission).toHaveBeenCalledTimes(2);
  });

  // ---------------------------------------------------------------------------
  // Interrupt / abort
  // ---------------------------------------------------------------------------

  it("interrupt sends abort", async () => {
    session = createSession();

    sub.push(buildOpencodeConnectedEvent());
    await waitForUnifiedMessageType(session, "session_init");

    session.send(createUserMessage("Start something"));
    session.send(createInterruptMessage());

    expect(httpClient.abort).toHaveBeenCalledOnce();
    expect(httpClient.abort).toHaveBeenCalledWith("opc-session-1");
  });

  it("interrupt uses correct opcSessionId", async () => {
    session = createSession("custom-session-42");

    session.send(createInterruptMessage());

    expect(httpClient.abort).toHaveBeenCalledWith("custom-session-42");
  });

  // ---------------------------------------------------------------------------
  // Tool flows
  // ---------------------------------------------------------------------------

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

  it("tool pending state is dropped (produces null)", async () => {
    session = createSession();
    const iter = session.messages[Symbol.asyncIterator]();

    sub.push(buildOpencodeToolPendingEvent({ callId: "call-pending-1" }));

    // Pending tool state should not produce a message
    const outcome = await Promise.race([
      iter.next().then(() => "message"),
      new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 30)),
    ]);

    expect(outcome).toBe("timeout");
  });

  it("multiple tool calls in a single turn", async () => {
    session = createSession();

    sub.push(buildOpencodeConnectedEvent());
    await waitForUnifiedMessageType(session, "session_init");

    session.send(createUserMessage("Read two files"));

    // Tool 1: running → completed
    sub.push(
      buildOpencodeToolRunningEvent({
        partId: "tp-1",
        callId: "call-1",
        tool: "read",
        input: { filePath: "foo.ts" },
      }),
    );
    sub.push(
      buildOpencodeToolCompletedEvent("export const foo = 1;", {
        partId: "tp-1",
        callId: "call-1",
        tool: "read",
        title: "foo.ts",
      }),
    );

    // Tool 2: running → completed
    sub.push(
      buildOpencodeToolRunningEvent({
        partId: "tp-2",
        callId: "call-2",
        tool: "read",
        input: { filePath: "bar.ts" },
      }),
    );
    sub.push(
      buildOpencodeToolCompletedEvent("export const bar = 2;", {
        partId: "tp-2",
        callId: "call-2",
        tool: "read",
        title: "bar.ts",
      }),
    );

    sub.push(buildOpencodeIdleEvent());

    const messages = await collectUnifiedMessages(session, 5);

    // Tool 1
    expect(messages[0].type).toBe("tool_progress");
    expect(messages[0].metadata.call_id).toBe("call-1");
    expect(messages[1].type).toBe("tool_use_summary");
    expect(messages[1].metadata.call_id).toBe("call-1");

    // Tool 2
    expect(messages[2].type).toBe("tool_progress");
    expect(messages[2].metadata.call_id).toBe("call-2");
    expect(messages[3].type).toBe("tool_use_summary");
    expect(messages[3].metadata.call_id).toBe("call-2");

    expect(messages[4].type).toBe("result");
  });

  it("tool completed preserves timing metadata", async () => {
    session = createSession();

    sub.push(
      buildOpencodeToolCompletedEvent("result output", {
        callId: "call-time",
        tool: "bash",
        title: "echo hello",
        start: 5_000,
        end: 5_750,
      }),
    );

    const messages = await collectUnifiedMessages(session, 1);
    expect(messages[0].type).toBe("tool_use_summary");
    expect(messages[0].metadata.time).toEqual({ start: 5_000, end: 5_750 });
  });

  // ---------------------------------------------------------------------------
  // Reasoning parts
  // ---------------------------------------------------------------------------

  it("reasoning parts are streamed but excluded from assistant text materialization", async () => {
    session = createSession();

    sub.push(buildOpencodeConnectedEvent());
    await waitForUnifiedMessageType(session, "session_init");

    session.send(createUserMessage("Think about this"));

    // Reasoning part (should be marked as reasoning)
    sub.push(
      buildOpencodeReasoningPartEvent("Let me think...", "Let me think...", {
        partId: "r-1",
        messageId: "m-1",
      }),
    );

    // Text part (should be included in assistant text)
    sub.push(
      buildOpencodeTextPartEvent("Here is my answer.", "Here is my answer.", {
        partId: "p-1",
        messageId: "m-1",
      }),
    );

    // message.updated materializes the assistant text
    sub.push(buildOpencodeAssistantUpdatedEvent({ messageId: "m-1" }));

    const messages = await collectUnifiedMessages(session, 3);

    // Reasoning part arrives as stream_event with reasoning flag
    expect(messages[0].type).toBe("stream_event");
    expect(messages[0].metadata.reasoning).toBe(true);

    // Text part arrives as stream_event
    expect(messages[1].type).toBe("stream_event");

    // Assistant text should contain ONLY the text part, not reasoning
    expect(messages[2].type).toBe("assistant");
    expect(messages[2].content).toEqual([{ type: "text", text: "Here is my answer." }]);
  });

  it("interleaved text and reasoning parts buffer correctly", async () => {
    session = createSession();

    session.send(createUserMessage("Complex task"));

    // Text → Reasoning → Text (different part IDs)
    sub.push(
      buildOpencodeTextPartEvent("Part A. ", "Part A. ", {
        partId: "text-1",
        messageId: "m-1",
      }),
    );
    sub.push(
      buildOpencodeReasoningPartEvent("thinking...", "thinking...", {
        partId: "reason-1",
        messageId: "m-1",
      }),
    );
    sub.push(
      buildOpencodeTextPartEvent("Part B.", "Part B.", {
        partId: "text-2",
        messageId: "m-1",
      }),
    );

    sub.push(buildOpencodeAssistantUpdatedEvent({ messageId: "m-1" }));

    const messages = await collectUnifiedMessages(session, 4);

    // Assistant text should concatenate text-1 + text-2, excluding reasoning
    expect(messages[3].type).toBe("assistant");
    expect(messages[3].content).toEqual([{ type: "text", text: "Part A. Part B." }]);
  });

  it("reasoning content block is included in stream_event content", async () => {
    session = createSession();

    sub.push(buildOpencodeReasoningPartEvent("Deep thought", "Deep thought"));

    const messages = await collectUnifiedMessages(session, 1);
    expect(messages[0].type).toBe("stream_event");
    expect(messages[0].content).toEqual([{ type: "thinking", thinking: "Deep thought" }]);
  });

  // ---------------------------------------------------------------------------
  // Text streaming and materialization
  // ---------------------------------------------------------------------------

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

  it("multiple text parts with different partIds concatenate on materialization", async () => {
    session = createSession();

    sub.push(
      buildOpencodeTextPartEvent("Hello ", "Hello ", {
        partId: "p-1",
        messageId: "m-1",
      }),
    );
    sub.push(
      buildOpencodeTextPartEvent("world!", "world!", {
        partId: "p-2",
        messageId: "m-1",
      }),
    );
    sub.push(buildOpencodeAssistantUpdatedEvent({ messageId: "m-1" }));

    const messages = await collectUnifiedMessages(session, 3);
    expect(messages[2].type).toBe("assistant");
    expect(messages[2].content).toEqual([{ type: "text", text: "Hello world!" }]);
  });

  it("text delta accumulates incrementally on same partId", async () => {
    session = createSession();

    sub.push(buildOpencodeTextDeltaEvent("foo", { partId: "p-1", messageId: "m-1" }));
    sub.push(buildOpencodeTextDeltaEvent("bar", { partId: "p-1", messageId: "m-1" }));
    sub.push(buildOpencodeTextDeltaEvent("baz", { partId: "p-1", messageId: "m-1" }));
    sub.push(buildOpencodeAssistantUpdatedEvent({ messageId: "m-1" }));

    const messages = await collectUnifiedMessages(session, 4);
    expect(messages[3].type).toBe("assistant");
    expect(messages[3].content).toEqual([{ type: "text", text: "foobarbaz" }]);
  });

  it("empty text delta is dropped", async () => {
    session = createSession();
    const iter = session.messages[Symbol.asyncIterator]();

    // message.part.delta with empty delta string should be dropped
    sub.push({
      type: "message.part.delta",
      properties: {
        sessionID: "opc-session-1",
        messageID: "m-1",
        partID: "p-1",
        field: "text",
        delta: "",
      },
    });

    const outcome = await Promise.race([
      iter.next().then(() => "message"),
      new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 30)),
    ]);

    expect(outcome).toBe("timeout");
  });

  it("non-text field delta is dropped", async () => {
    session = createSession();
    const iter = session.messages[Symbol.asyncIterator]();

    // Delta with field != "text" should be dropped
    sub.push({
      type: "message.part.delta",
      properties: {
        sessionID: "opc-session-1",
        messageID: "m-1",
        partID: "p-1",
        field: "reasoning",
        delta: "some reasoning content",
      },
    });

    const outcome = await Promise.race([
      iter.next().then(() => "message"),
      new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 30)),
    ]);

    expect(outcome).toBe("timeout");
  });

  it("stream state is cleared after result (idle event)", async () => {
    session = createSession();

    // Turn 1: accumulate text
    sub.push(
      buildOpencodeTextPartEvent("Turn 1 text", "Turn 1 text", {
        partId: "p-1",
        messageId: "m-1",
      }),
    );
    sub.push(buildOpencodeAssistantUpdatedEvent({ messageId: "m-1" }));
    sub.push(buildOpencodeIdleEvent());

    const turn1 = await collectUnifiedMessages(session, 3);
    expect(turn1[0].type).toBe("stream_event");
    expect(turn1[1].type).toBe("assistant");
    expect(turn1[1].content).toEqual([{ type: "text", text: "Turn 1 text" }]);
    expect(turn1[2].type).toBe("result");

    // Turn 2: new message ID, no residual text from turn 1
    sub.push(buildOpencodeAssistantUpdatedEvent({ messageId: "m-2" }));

    const messages = await collectUnifiedMessages(session, 1);
    expect(messages[0].type).toBe("assistant");
    // No buffered text from turn 1 should leak into turn 2
    expect(messages[0].content).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // Step events
  // ---------------------------------------------------------------------------

  it("step-start emits status_change with step: start", async () => {
    session = createSession();

    sub.push(buildOpencodeStepStartEvent({ partId: "step-1", messageId: "m-1" }));

    const messages = await collectUnifiedMessages(session, 1);
    expect(messages[0].type).toBe("status_change");
    expect(messages[0].metadata.step).toBe("start");
    expect(messages[0].metadata.step_id).toBe("step-1");
    expect(messages[0].metadata.message_id).toBe("m-1");
  });

  it("step-finish emits status_change with step: finish", async () => {
    session = createSession();

    sub.push(buildOpencodeStepFinishEvent({ partId: "step-end-1", messageId: "m-1" }));

    const messages = await collectUnifiedMessages(session, 1);
    expect(messages[0].type).toBe("status_change");
    expect(messages[0].metadata.step).toBe("finish");
    expect(messages[0].metadata.step_id).toBe("step-end-1");
  });

  // ---------------------------------------------------------------------------
  // Session lifecycle events
  // ---------------------------------------------------------------------------

  it("session.compacted emits session_lifecycle", async () => {
    session = createSession();

    sub.push(buildOpencodeCompactedEvent("opc-session-1"));

    const { target: msg } = await waitForUnifiedMessageType(session, "session_lifecycle");
    expect(msg.metadata.subtype).toBe("session_compacted");
    expect(msg.metadata.session_id).toBe("opc-session-1");
  });

  it("message.removed emits session_lifecycle", async () => {
    session = createSession();

    sub.push(buildOpencodeMessageRemovedEvent("m-old-1", "opc-session-1"));

    const { target: msg } = await waitForUnifiedMessageType(session, "session_lifecycle");
    expect(msg.metadata.subtype).toBe("message_removed");
    expect(msg.metadata.message_id).toBe("m-old-1");
    expect(msg.metadata.session_id).toBe("opc-session-1");
  });

  it("inbound user message.updated echoes as user_message", async () => {
    session = createSession();

    sub.push(buildOpencodeUserUpdatedEvent({ messageId: "m-user-echo" }));

    const { target: msg } = await waitForUnifiedMessageType(session, "user_message");
    expect(msg.metadata.message_id).toBe("m-user-echo");
    expect(msg.metadata.session_id).toBe("opc-session-1");
  });

  // ---------------------------------------------------------------------------
  // Status events
  // ---------------------------------------------------------------------------

  it("session.status retry emits retry metadata", async () => {
    session = createSession();

    sub.push(buildOpencodeRetryEvent({ attempt: 2, message: "rate limited", next: 3_000 }));

    const { target: status } = await waitForUnifiedMessageType(session, "status_change");
    expect(status.metadata.retry).toBe(true);
    expect(status.metadata.attempt).toBe(2);
    expect(status.metadata.message).toBe("rate limited");
    expect(status.metadata.next).toBe(3_000);
  });

  // ---------------------------------------------------------------------------
  // Error handling
  // ---------------------------------------------------------------------------

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

  it.each([
    { name: "provider_auth" as const, expectedCode: "provider_auth" },
    { name: "output_length" as const, expectedCode: "output_length" },
    { name: "aborted" as const, expectedCode: "aborted" },
    { name: "context_overflow" as const, expectedCode: "context_overflow" },
  ])("session.error $name maps to $expectedCode", async ({ name, expectedCode }) => {
    session = createSession();

    sub.push(buildOpencodeSessionErrorEvent({ name, message: `Error: ${name}` }));

    const { target: result } = await waitForUnifiedMessageType(session, "result");
    expect(result.metadata.is_error).toBe(true);
    expect(result.metadata.error_code).toBe(expectedCode);
    expect(result.metadata.error_message).toBe(`Error: ${name}`);

    await session.close();
    session = undefined;
  });

  it("error recovery: session error followed by new turn works", async () => {
    session = createSession();

    sub.push(buildOpencodeConnectedEvent());
    await waitForUnifiedMessageType(session, "session_init");

    // Error occurs
    sub.push(
      buildOpencodeSessionErrorEvent({ name: "api_error", message: "Transient", status: 500 }),
    );

    const { target: errResult } = await waitForUnifiedMessageType(session, "result");
    expect(errResult.metadata.is_error).toBe(true);

    // New turn should still work
    session.send(createUserMessage("Try again"));
    expect(httpClient.promptAsync).toHaveBeenCalledOnce();

    sub.push(buildOpencodeTextPartEvent("Recovered", "Recovered"));
    sub.push(buildOpencodeIdleEvent());

    const messages = await collectUnifiedMessages(session, 2);
    expect(messages[0].type).toBe("stream_event");
    expect(messages[0].metadata.delta).toBe("Recovered");
    expect(messages[1].type).toBe("result");
  });

  it("HTTP error surfaces as error result in message queue", async () => {
    session = createSession();

    httpClient.promptAsync.mockRejectedValueOnce(new Error("Network failure"));

    session.send(createUserMessage("will fail"));

    // Wait for the rejected promise to be caught
    await tick();

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

  it("non-Error rejection is stringified in error result", async () => {
    session = createSession();

    httpClient.promptAsync.mockRejectedValueOnce("string error");

    session.send(createUserMessage("will fail"));
    await tick();

    const { target: result } = await waitForUnifiedMessageType(session, "result");
    expect(result.metadata.is_error).toBe(true);
    expect(result.metadata.error_message).toBe("string error");
  });

  // ---------------------------------------------------------------------------
  // Outbound message translation
  // ---------------------------------------------------------------------------

  it("user_message with model override passes model to prompt action", async () => {
    session = createSession();

    const msg = createUnifiedMessage({
      type: "user_message",
      role: "user",
      content: [{ type: "text", text: "Hello" }],
      metadata: {
        model: { providerID: "anthropic", modelID: "claude-sonnet-4-5-20250929" },
      },
    });
    session.send(msg);

    expect(httpClient.promptAsync).toHaveBeenCalledOnce();
    const callArgs = httpClient.promptAsync.mock.calls[0];
    expect(callArgs[1]).toEqual({
      parts: [{ type: "text", text: "Hello" }],
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-5-20250929" },
    });
  });

  it("user_message with no content blocks falls through to metadata.text", async () => {
    session = createSession();

    const msg = createUnifiedMessage({
      type: "user_message",
      role: "user",
      content: [],
      metadata: { text: "Fallback text" },
    });
    session.send(msg);

    expect(httpClient.promptAsync).toHaveBeenCalledOnce();
    const callArgs = httpClient.promptAsync.mock.calls[0];
    expect(callArgs[1]).toEqual({
      parts: [{ type: "text", text: "Fallback text" }],
      model: undefined,
    });
  });

  it("session_init message is a noop (no HTTP call)", async () => {
    session = createSession();

    const msg = createUnifiedMessage({
      type: "session_init",
      role: "system",
      metadata: {},
    });
    session.send(msg);

    expect(httpClient.promptAsync).not.toHaveBeenCalled();
    expect(httpClient.abort).not.toHaveBeenCalled();
    expect(httpClient.replyPermission).not.toHaveBeenCalled();
  });

  it("unsupported message type throws", () => {
    session = createSession();

    const msg = createUnifiedMessage({
      type: "result",
      role: "system",
      metadata: {},
    });

    expect(() => session!.send(msg)).toThrow("Unsupported message type for opencode: result");
  });

  it("sendRaw throws (not supported)", () => {
    session = createSession();

    expect(() => session!.sendRaw("{}")).toThrow("opencode adapter does not support raw NDJSON");
  });

  // ---------------------------------------------------------------------------
  // Assistant message metadata
  // ---------------------------------------------------------------------------

  it("assistant message.updated carries model and token metadata", async () => {
    session = createSession();

    sub.push(
      buildOpencodeTextPartEvent("answer", "answer", {
        partId: "p-1",
        messageId: "m-meta",
      }),
    );
    sub.push(
      buildOpencodeAssistantUpdatedEvent({
        messageId: "m-meta",
        modelId: "claude-sonnet-4-5-20250929",
        providerId: "anthropic",
      }),
    );

    const messages = await collectUnifiedMessages(session, 2);
    expect(messages[1].type).toBe("assistant");
    expect(messages[1].metadata.model_id).toBe("claude-sonnet-4-5-20250929");
    expect(messages[1].metadata.provider_id).toBe("anthropic");
    expect(messages[1].metadata.tokens).toBeDefined();
    expect(messages[1].metadata.cost).toBeDefined();
  });

  it("assistant message.updated with error field preserves it", async () => {
    session = createSession();

    sub.push(
      buildOpencodeAssistantUpdatedEvent({
        messageId: "m-err",
        error: { name: "output_length", data: { message: "Max tokens exceeded" } },
      }),
    );

    const messages = await collectUnifiedMessages(session, 1);
    expect(messages[0].type).toBe("assistant");
    expect(messages[0].metadata.error).toEqual({
      name: "output_length",
      data: { message: "Max tokens exceeded" },
    });
  });

  it("assistant message.updated with finish reason preserves it", async () => {
    session = createSession();

    sub.push(
      buildOpencodeAssistantUpdatedEvent({
        messageId: "m-finish",
        finish: "end_turn",
      }),
    );

    const messages = await collectUnifiedMessages(session, 1);
    expect(messages[0].type).toBe("assistant");
    expect(messages[0].metadata.finish).toBe("end_turn");
  });

  // ---------------------------------------------------------------------------
  // Event filtering
  // ---------------------------------------------------------------------------

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

  it("drops session.created, session.updated, session.deleted, session.diff", async () => {
    session = createSession();
    const iter = session.messages[Symbol.asyncIterator]();

    sub.push({
      type: "session.created",
      properties: {
        info: {
          id: "s-1",
          slug: "test",
          projectID: "proj-1",
          directory: "/tmp",
          title: "Test",
          version: "1",
          time: { created: 0, updated: 0 },
        },
      },
    } as any);
    sub.push({
      type: "session.updated",
      properties: {
        info: {
          id: "s-1",
          slug: "test",
          projectID: "proj-1",
          directory: "/tmp",
          title: "Test",
          version: "1",
          time: { created: 0, updated: 0 },
        },
      },
    } as any);
    sub.push({
      type: "session.deleted",
      properties: { sessionID: "s-1" },
    });
    sub.push({
      type: "session.diff",
      properties: { sessionID: "s-1", diffs: [] },
    });

    const outcome = await Promise.race([
      iter.next().then(() => "message"),
      new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 30)),
    ]);

    expect(outcome).toBe("timeout");
  });

  // ---------------------------------------------------------------------------
  // Session close behavior
  // ---------------------------------------------------------------------------

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

  it("close is idempotent (calling twice does not throw)", async () => {
    session = createSession();

    await session.close();
    await session.close(); // Should not throw

    expect(sub.unsubscribe).toHaveBeenCalledOnce();
    session = undefined;
  });

  it("events received after close are not enqueued", async () => {
    session = createSession();
    const iter = session.messages[Symbol.asyncIterator]();

    await session.close();

    // Push events after close — they should be ignored since handler is unsubscribed
    sub.push(buildOpencodeConnectedEvent());
    sub.push(buildOpencodeTextPartEvent("late", "late"));

    const result = await iter.next();
    expect(result.done).toBe(true);
    session = undefined;
  });
});
