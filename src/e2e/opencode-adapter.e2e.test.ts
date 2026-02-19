/**
 * OpencodeAdapter e2e tests — exercises OpencodeSession directly with mock
 * OpencodeHttpClient + mock subscribe, testing full multi-turn flows.
 */

import { afterEach, describe, expect, it } from "vitest";
import { OpencodeSession } from "../adapters/opencode/opencode-session.js";
import type { BackendSession } from "../core/interfaces/backend-adapter.js";
import {
  buildOpencodeBusyEvent,
  buildOpencodeConnectedEvent,
  buildOpencodeIdleEvent,
  buildOpencodePermissionEvent,
  buildOpencodeTextPartEvent,
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

  it("interrupt sends abort", async () => {
    session = createSession();

    sub.push(buildOpencodeConnectedEvent());
    await waitForUnifiedMessageType(session, "session_init");

    session.send(createUserMessage("Start something"));
    session.send(createInterruptMessage());

    expect(httpClient.abort).toHaveBeenCalledOnce();
    expect(httpClient.abort).toHaveBeenCalledWith("opc-session-1");
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
