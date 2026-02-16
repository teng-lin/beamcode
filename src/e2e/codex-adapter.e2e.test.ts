/**
 * CodexAdapter e2e tests — exercises CodexSession directly with MockWebSocket,
 * bypassing the launch+connect+handshake flow.
 */

import { afterEach, describe, expect, it } from "vitest";
import type WebSocket from "ws";
import { CodexLauncher } from "../adapters/codex/codex-launcher.js";
import { CodexSession } from "../adapters/codex/codex-session.js";
import type { BackendSession } from "../core/interfaces/backend-adapter.js";
import {
  collectUnifiedMessages,
  createInterruptMessage,
  createMockProcessManager,
  createPermissionResponse,
  createUserMessage,
  MockWebSocket,
  sendCodexNotification,
  waitForUnifiedMessageType,
} from "./helpers/backend-test-utils.js";

describe("E2E: CodexAdapter", () => {
  let session: BackendSession | undefined;
  let ws: MockWebSocket;

  function createSession(options?: { initResponse?: boolean }): CodexSession {
    ws = new MockWebSocket();
    const launcher = new CodexLauncher({
      processManager: createMockProcessManager(),
    });

    return new CodexSession({
      sessionId: "e2e-codex",
      ws: ws as unknown as WebSocket,
      launcher,
      initResponse:
        options?.initResponse !== false
          ? { capabilities: { streaming: true }, version: "1.0" }
          : undefined,
    });
  }

  afterEach(async () => {
    if (session) {
      await session.close();
      session = undefined;
    }
  });

  it("full turn with streaming: text deltas → item done → response.completed", async () => {
    session = createSession();

    // Consume init message
    const { target: initMsg } = await waitForUnifiedMessageType(session, "session_init");
    expect(initMsg.metadata.version).toBe("1.0");

    // Send user message
    session.send(createUserMessage("Hello Codex"));
    expect(ws.sent).toHaveLength(1);

    const sentMsg = JSON.parse(ws.sent[0]);
    expect(sentMsg.method).toBe("turn.create");

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
    expect(messages[2].metadata.done).toBe(true);

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
    expect(permReq.metadata.call_id).toBe("call-1");

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

    // Should get the partial message, then stream should end
    const messages = await collectUnifiedMessages(session, 2, 1000);
    expect(messages.length).toBeGreaterThanOrEqual(1);
    expect(messages[0].type).toBe("stream_event");
    expect(messages[0].metadata.delta).toBe("partial...");
  });

  it("WebSocket error ends message stream", async () => {
    session = createSession();
    await waitForUnifiedMessageType(session, "session_init");

    session.send(createUserMessage("Start"));

    // Emit error
    ws.emit("error", new Error("Connection lost"));

    // Stream should end
    const messages = await collectUnifiedMessages(session, 1, 500);
    // May or may not collect any messages, but stream shouldn't hang
    expect(messages.length).toBeLessThanOrEqual(1);
  });

  it("send after close throws", async () => {
    session = createSession();
    await session.close();

    expect(() => session!.send(createUserMessage("after close"))).toThrow("Session is closed");
    session = undefined; // already closed
  });
});
